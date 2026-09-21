"""Chatterbox worker: loads Chatterbox Multilingual V3 once, answers one JSON job per stdin line.

Runs in the Chatterbox venv (Python 3.12, torch 2.6.0+cu124). Protocol matches maya1_worker.
  in : {"text": "...", "out": "...", "reference": "...wav", "seed": 1234,
        "exaggeration": 0.5, "cfg_weight": 0.5}

Chatterbox renders past full scale (measured up to 1.12), which clips when written as PCM_16,
so every clip is peak-limited on the way out.
"""
import json
import sys
import time

import numpy as np
import soundfile as sf
import torch

MODEL_DIR = "H:/H3RemoteStudio/Chatterbox/model"
PEAK_LIMIT = 0.89


def main():
    from chatterbox.mtl_tts import ChatterboxMultilingualTTS
    model = ChatterboxMultilingualTTS.from_local(MODEL_DIR, device="cuda")
    print(json.dumps({"ok": True, "ready": True, "engine": "chatterbox", "sample_rate": model.sr}),
          flush=True)

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
            started = time.time()
            wav = model.generate(
                job["text"], language_id="en",
                audio_prompt_path=job["reference"],
                exaggeration=float(job.get("exaggeration", 0.5)),
                cfg_weight=float(job.get("cfg_weight", 0.5)))
            wav = wav.squeeze().cpu().numpy()
            peak = float(np.abs(wav).max()) or 1.0
            if peak > PEAK_LIMIT:
                wav = wav * (PEAK_LIMIT / peak)
            sf.write(job["out"], wav, model.sr, subtype="PCM_16")
            print(json.dumps({"ok": True, "seconds": round(len(wav) / model.sr, 2),
                              "sample_rate": model.sr, "wall": round(time.time() - started, 1),
                              "peak": round(peak, 3)}), flush=True)
        except Exception as caught:
            print(json.dumps({"ok": False, "error": f"{type(caught).__name__}: {caught}"}), flush=True)


if __name__ == "__main__":
    main()
