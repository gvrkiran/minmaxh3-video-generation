"""Speak English lines with Piper. Runs in the CPU tooling venv, driven by variants.py.

Separate from variants.py because Piper lives in the tooling venv while the render pipeline
runs in its own. It reads one JSON object on stdin so no text ever goes through a command
line, which would mangle punctuation and non-ASCII names.

Piper is MIT-licensed and runs on the CPU at roughly forty times real time, which is why the
English narration never has to wait for the graphics card.
"""
from __future__ import annotations

import json
import sys
import wave
from pathlib import Path


def main() -> None:
    job = json.load(sys.stdin)
    out_dir = Path(job["out"])
    out_dir.mkdir(parents=True, exist_ok=True)

    from piper import PiperVoice
    voice = PiperVoice.load(job["model"])

    for name, text in job["texts"].items():
        target = out_dir / f"{name}.wav"
        with wave.open(str(target), "wb") as handle:
            voice.synthesize_wav(text, handle)
        with wave.open(str(target)) as handle:
            seconds = handle.getnframes() / handle.getframerate()
        print(f"{name:16} {seconds:6.2f}s  {len(text)} chars", flush=True)


if __name__ == "__main__":
    main()
