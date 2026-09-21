"""Maya1 worker: loads the model once, then answers one JSON job per stdin line.

Runs in the IndicSpeak venv (transformers 5.x + snac). Protocol:
  in : {"text": "...", "out": "C:/path/out.wav", "description": "...", "seed": 1234,
        "temperature": 0.4, "repetition_penalty": 1.1}
  out: {"ok": true, "seconds": 11.9, "sample_rate": 24000}
A line {"cmd": "ping"} answers {"ok": true, "ready": true} without generating.
"""
import json
import sys
import time

import numpy as np
import soundfile as sf
import torch
from snac import SNAC
from transformers import AutoModelForCausalLM, AutoTokenizer

MODEL_DIR = "H:/H3RemoteStudio/Maya1/model"
SNAC_DIR = "H:/H3RemoteStudio/Maya1/snac_24khz"

CODE_START_TOKEN_ID = 128257
CODE_END_TOKEN_ID = 128258
CODE_TOKEN_OFFSET = 128266
SNAC_MIN_ID = 128266
SNAC_MAX_ID = 156937
SOH_ID = 128259
EOH_ID = 128260
SOA_ID = 128261
TEXT_EOT_ID = 128009
SR = 24000


def build_prompt(tok, description, text):
    return (tok.decode([SOH_ID]) + tok.bos_token + f'<description="{description}"> {text}'
            + tok.decode([TEXT_EOT_ID]) + tok.decode([EOH_ID]) + tok.decode([SOA_ID])
            + tok.decode([CODE_START_TOKEN_ID]))


def unpack(snac_tokens):
    frames = len(snac_tokens) // 7
    l1, l2, l3 = [], [], []
    for i in range(frames):
        s = snac_tokens[i * 7:(i + 1) * 7]
        l1.append((s[0] - CODE_TOKEN_OFFSET) % 4096)
        l2.extend([(s[1] - CODE_TOKEN_OFFSET) % 4096, (s[4] - CODE_TOKEN_OFFSET) % 4096])
        l3.extend([(s[j] - CODE_TOKEN_OFFSET) % 4096 for j in (2, 3, 5, 6)])
    return [l1, l2, l3]


def main():
    model = AutoModelForCausalLM.from_pretrained(MODEL_DIR, dtype=torch.bfloat16).to("cuda").eval()
    tok = AutoTokenizer.from_pretrained(MODEL_DIR)
    snac = SNAC.from_pretrained(SNAC_DIR).eval().to("cuda")
    print(json.dumps({"ok": True, "ready": True, "engine": "maya1"}), flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            job = json.loads(line)
            if job.get("cmd") == "ping":
                print(json.dumps({"ok": True, "ready": True}), flush=True)
                continue

            torch.manual_seed(int(job.get("seed", 1234)))
            prompt = build_prompt(tok, job["description"], job["text"])
            inputs = tok(prompt, return_tensors="pt").to("cuda")
            started = time.time()
            with torch.inference_mode():
                gen = model.generate(
                    **inputs, max_new_tokens=int(job.get("max_new_tokens", 3072)),
                    min_new_tokens=28, temperature=float(job.get("temperature", 0.4)), top_p=0.9,
                    repetition_penalty=float(job.get("repetition_penalty", 1.1)), do_sample=True,
                    eos_token_id=CODE_END_TOKEN_ID, pad_token_id=tok.pad_token_id)
            ids = gen[0, inputs["input_ids"].shape[1]:].tolist()
            if CODE_END_TOKEN_ID in ids:
                ids = ids[:ids.index(CODE_END_TOKEN_ID)]
            codes = [i for i in ids if SNAC_MIN_ID <= i <= SNAC_MAX_ID]
            levels = unpack(codes)
            if not levels[0]:
                print(json.dumps({"ok": False, "error": "model produced no audio tokens"}), flush=True)
                continue
            tensors = [torch.tensor(l, dtype=torch.long, device="cuda").unsqueeze(0) for l in levels]
            with torch.inference_mode():
                audio = snac.decoder(snac.quantizer.from_codes(tensors))[0, 0].float().cpu().numpy()
            audio = audio[2048:] if len(audio) > 2048 else audio
            # Maya1 has never exceeded 0.89 in testing, but never ship a clipped file.
            peak = float(np.abs(audio).max()) or 1.0
            if peak > 0.97:
                audio = audio * (0.97 / peak)
            sf.write(job["out"], audio, SR, subtype="PCM_16")
            print(json.dumps({"ok": True, "seconds": round(len(audio) / SR, 2),
                              "sample_rate": SR, "wall": round(time.time() - started, 1),
                              "peak": round(peak, 3)}), flush=True)
        except Exception as caught:  # one bad job must not kill a warm worker
            print(json.dumps({"ok": False, "error": f"{type(caught).__name__}: {caught}"}), flush=True)


if __name__ == "__main__":
    main()
