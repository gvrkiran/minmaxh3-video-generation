"""Kathalu Studio -- synthesise every scene's Telugu in ONE IndicF5 session.

Runs in the IndicF5 venv (H:\\H3RemoteStudio\\IndicF5\\venv), because torch and f5-tts live
there and pin numpy<=1.26.4. Called as a subprocess by the pipeline rather than imported.

This is the first half of the audio-first ordering: nothing about the video is decided until
the voice exists and has been measured. Loading the model once for the whole story rather
than once per shot is the other half of why the ordering pays -- model load is ~12.5 s and
synthesis runs at 0.40x real time, so a 90-second story narrates in well under a minute.

ComfyUI is asked to release the GPU first. On a 24 GB card, H3's ~20 GB and this model
cannot both be resident.

Usage:
  python narrate.py --script script.json --dir H:\\KathaluStudio\\stories\\the-fox\\
"""
from __future__ import annotations

import argparse
import json
import time
import urllib.request
from pathlib import Path

import numpy as np
import soundfile as sf
import torch
import torchaudio
from transformers import AutoModel

# Windows: TorchCodec wheels want shared FFmpeg DLLs; libsndfile does not.
def _sf_load(uri, *a, **k):
    audio, sr = sf.read(str(uri), dtype="float32", always_2d=True)
    return torch.from_numpy(audio.T.copy()), int(sr)


torchaudio.load = _sf_load

SR = 24000
# The reference clips live in the app's work/ directory. Derived from this file's own
# location rather than hardcoded, because the repo has already moved once.
VOICES = Path(__file__).resolve().parents[3] / "work" / "indicf5" / "voices"
BUILTIN = {
    "female": (VOICES / "built-in-female.wav",
               "ਇੱਕ ਗ੍ਰਾਹਕ ਨੇ ਸਾਡੀ ਬੇਮਿਸਾਲ ਸੇਵਾ ਬਾਰੇ ਦਿਲੋਂ ਗਵਾਹੀ ਦਿੱਤੀ ਜਿਸ ਨਾਲ ਸਾਨੂੰ ਅਨੰਦ ਮਹਿਸੂਸ ਹੋਇਆ।"),
    "male": (VOICES / "built-in-male.wav",
             "या प्रथाला एकोणीसशे पंचातर ईसवी पासून भारतीय दंड संहिताची धारा चारशे अठ्ठावीस आणि चारशे एकोणतीसच्या अन्तर्गत निषेध केला."),
}


def release_comfy() -> None:
    try:
        req = urllib.request.Request(
            "http://127.0.0.1:8188/free",
            data=json.dumps({"unload_models": True, "free_memory": True}).encode(),
            headers={"content-type": "application/json"})
        urllib.request.urlopen(req, timeout=90).read()
        time.sleep(1.5)
        print("  ComfyUI released the GPU")
    except Exception as exc:                                  # noqa: BLE001
        print(f"  (could not reach ComfyUI to free it: {type(exc).__name__})")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--script", required=True)
    ap.add_argument("--dir", required=True)
    ap.add_argument("--voice", default="female", choices=["female", "male"])
    a = ap.parse_args()

    script = json.loads(Path(a.script).read_text(encoding="utf-8"))
    out_dir = Path(a.dir) / "narration"
    out_dir.mkdir(parents=True, exist_ok=True)
    ref_wav, ref_text = BUILTIN[a.voice]

    scenes = script["scenes"]
    todo = [s for s in scenes if not (out_dir / f"scene_{s['index']:02d}.wav").exists()]
    print(f"{len(scenes)} scene(s), {len(todo)} to synthesise "
          f"({len(scenes) - len(todo)} already done)")

    model = None
    if todo:
        release_comfy()
        t0 = time.time()
        model = AutoModel.from_pretrained("ai4bharat/IndicF5", trust_remote_code=True)
        model = model.to(torch.device("cuda" if torch.cuda.is_available() else "cpu")).eval()
        print(f"  IndicF5 loaded in {time.time() - t0:.1f}s on "
              f"{'cuda' if torch.cuda.is_available() else 'cpu'}")

    results = []
    for scene in scenes:
        wav = out_dir / f"scene_{scene['index']:02d}.wav"
        if wav.exists():
            audio, _ = sf.read(str(wav), dtype="float32", always_2d=False)
            secs = len(audio) / SR
            print(f"  scene {scene['index']:2d}  cached      {secs:6.2f}s")
        else:
            t0 = time.time()
            with torch.inference_mode():
                audio = model(scene["telugu_narration"],
                              ref_audio_path=str(ref_wav), ref_text=ref_text)
            if getattr(audio, "dtype", None) == np.int16:
                audio = audio.astype(np.float32) / 32768.0
            audio = np.asarray(audio, dtype=np.float32)
            peak = float(np.max(np.abs(audio)))
            if peak > 0.98:
                audio *= 0.98 / peak
            sf.write(str(wav), audio, samplerate=SR, subtype="PCM_16")
            secs = len(audio) / SR
            print(f"  scene {scene['index']:2d}  {time.time() - t0:5.1f}s synth  "
                  f"{secs:6.2f}s audio  {scene['narration_chars']:3d}ch  "
                  f"{scene['narration_chars'] / secs:5.2f} ch/s")

        results.append({
            "index": scene["index"],
            "wav": str(wav),
            "seconds": round(float(secs), 3),
            "chars": scene["narration_chars"],
            "estimated_seconds": scene["estimated_seconds"],
        })

    # The closing card needs the moral spoken too. Same session, same voice.
    moral = (script.get("telugu_moral") or "").strip()
    moral_wav = out_dir / "moral.wav"
    if moral and not moral_wav.exists():
        if model is None:
            release_comfy()
            model = AutoModel.from_pretrained("ai4bharat/IndicF5", trust_remote_code=True)
            model = model.to(torch.device("cuda" if torch.cuda.is_available() else "cpu")).eval()
        with torch.inference_mode():
            audio = model(moral, ref_audio_path=str(ref_wav), ref_text=ref_text)
        if getattr(audio, "dtype", None) == np.int16:
            audio = audio.astype(np.float32) / 32768.0
        audio = np.asarray(audio, dtype=np.float32)
        peak = float(np.max(np.abs(audio)))
        if peak > 0.98:
            audio *= 0.98 / peak
        sf.write(str(moral_wav), audio, samplerate=SR, subtype="PCM_16")
        print(f"  moral      {len(audio) / SR:6.2f}s audio")
    elif moral:
        print("  moral      cached")

    if model is not None:
        del model
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        print("  IndicF5 unloaded")

    total = sum(r["seconds"] for r in results)
    est = sum(r["estimated_seconds"] for r in results)
    payload = {"voice": a.voice, "sample_rate": SR, "scenes": results,
               "moral_wav": str(moral_wav) if moral and moral_wav.exists() else None,
               "total_seconds": round(total, 2), "estimated_total_seconds": round(est, 2)}
    (Path(a.dir) / "narration.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n{total:.2f}s of narration measured "
          f"(char-budget estimate was {est:.2f}s, off by {abs(total - est) / max(est, 1e-9):.1%})")


if __name__ == "__main__":
    main()
