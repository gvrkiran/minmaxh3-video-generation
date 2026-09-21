"""Afro-TTS worker: loads the Afro-TTS XTTS checkpoint once, answers one JSON job per stdin line.

Runs in the AfroTTS venv (Python 3.10, TTS==0.22.0, transformers pinned to 4.49.0 -- newer
transformers removes classes this package imports). Protocol matches the other workers.
  in : {"text": "...", "out": "...", "reference": "...wav", "seed": 1234,
        "gpt_cond_len": 6, "temperature": 0.75}
"""
import json
import sys
import time

import numpy as np
import soundfile as sf
import torch
from TTS.tts.configs.xtts_config import XttsConfig
from TTS.tts.models.xtts import Xtts

MODEL_DIR = "H:/H3RemoteStudio/AfroTTS/model"
SR = 24000
PEAK_LIMIT = 0.89


def main():
    config = XttsConfig()
    config.load_json(f"{MODEL_DIR}/config.json")
    model = Xtts.init_from_config(config)
    model.load_checkpoint(config, checkpoint_dir=MODEL_DIR, eval=True)
    model.cuda()
    print(json.dumps({"ok": True, "ready": True, "engine": "afrotts", "sample_rate": SR}), flush=True)

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
            outputs = model.synthesize(
                job["text"], config,
                speaker_wav=job["reference"],
                gpt_cond_len=int(job.get("gpt_cond_len", 6)),
                temperature=float(job.get("temperature", 0.75)),
                language="en")
            wav = np.asarray(outputs["wav"], dtype=np.float32)
            peak = float(np.abs(wav).max()) or 1.0
            if peak > PEAK_LIMIT:
                wav = wav * (PEAK_LIMIT / peak)
            sf.write(job["out"], wav, SR, subtype="PCM_16")
            print(json.dumps({"ok": True, "seconds": round(len(wav) / SR, 2),
                              "sample_rate": SR, "wall": round(time.time() - started, 1),
                              "peak": round(peak, 3)}), flush=True)
        except Exception as caught:
            print(json.dumps({"ok": False, "error": f"{type(caught).__name__}: {caught}"}), flush=True)


if __name__ == "__main__":
    main()
