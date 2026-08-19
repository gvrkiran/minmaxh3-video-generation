from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import subprocess
import time
import uuid
from pathlib import Path
from typing import Any

import httpx
import numpy as np
import soundfile as sf
import torch
import torchaudio
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from transformers import AutoModel


def soundfile_audio_load(uri: str | os.PathLike[str], *args: Any, **kwargs: Any) -> tuple[torch.Tensor, int]:
    """Use libsndfile for references; TorchCodec's Windows wheels require shared FFmpeg DLLs."""
    del args, kwargs
    audio, sample_rate = sf.read(str(uri), dtype="float32", always_2d=True)
    return torch.from_numpy(audio.T.copy()), int(sample_rate)


torchaudio.load = soundfile_audio_load


ROOT = Path(os.environ.get("H3_STUDIO_ROOT", Path(__file__).resolve().parents[2]))
STATE_ROOT = ROOT / "work" / "indicf5"
VOICE_ROOT = STATE_ROOT / "voices"
LOG_ROOT = STATE_ROOT / "logs"
COMFY_URL = os.environ.get("COMFY_URL", "http://127.0.0.1:8188")
OUTPUT_ROOT = Path(os.environ.get("COMFY_OUTPUT_ROOT", r"C:\Users\kg766\Downloads\ComfyUI\output"))
MODEL_ID = "ai4bharat/IndicF5"
POLL_SECONDS = 4

VOICE_ROOT.mkdir(parents=True, exist_ok=True)
LOG_ROOT.mkdir(parents=True, exist_ok=True)

BUILTIN_VOICES = {
    "female": {
        "path": VOICE_ROOT / "built-in-female.wav",
        "text": "ਇੱਕ ਗ੍ਰਾਹਕ ਨੇ ਸਾਡੀ ਬੇਮਿਸਾਲ ਸੇਵਾ ਬਾਰੇ ਦਿਲੋਂ ਗਵਾਹੀ ਦਿੱਤੀ ਜਿਸ ਨਾਲ ਸਾਨੂੰ ਅਨੰਦ ਮਹਿਸੂਸ ਹੋਇਆ।",
    },
    "male": {
        "path": VOICE_ROOT / "built-in-male.wav",
        "text": "या प्रथाला एकोणीसशे पंचातर ईसवी पासून भारतीय दंड संहिताची धारा चारशे अठ्ठावीस आणि चारशे एकोणतीसच्या अन्तर्गत निषेध केला.",
    },
}

app = FastAPI(title="IndicF5 Narration Service")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:3000", "http://localhost:3000", "http://100.90.163.26:3000"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

model: Any | None = None
model_lock = asyncio.Lock()
last_error: str | None = None
active_job: str | None = None
completed_jobs: dict[str, dict[str, str]] = {}


def run(command: list[str]) -> str:
    result = subprocess.run(command, check=True, capture_output=True, text=True, encoding="utf-8")
    return result.stdout.strip()


def media_duration(path: Path) -> float:
    return float(run([
        "ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1", str(path),
    ]))


def output_video(entry: dict[str, Any]) -> tuple[str, str] | None:
    for value in (entry.get("outputs") or {}).values():
        for item in value.get("images") or []:
            filename = str(item.get("filename", ""))
            if filename.lower().endswith(".mp4") and not filename.lower().endswith("_tts.mp4"):
                return filename, str(item.get("subfolder", ""))
    return None


def tts_metadata(entry: dict[str, Any]) -> dict[str, Any] | None:
    prompt = entry.get("prompt") or []
    graph = prompt[2] if len(prompt) > 2 and isinstance(prompt[2], dict) else {}
    for node in graph.values():
        metadata = node.get("_meta") if isinstance(node, dict) else None
        tts = metadata.get("h3_tts") if isinstance(metadata, dict) else None
        has_script = str(tts.get("text", "")).strip() or (
            isinstance(tts.get("segmentsJson"), str) and tts["segmentsJson"].strip() not in {"", "[]"}
        ) if isinstance(tts, dict) else False
        if isinstance(tts, dict) and tts.get("enabled") and has_script:
            return tts
    return None


def resolve_voice_name(voice: str) -> tuple[Path, str]:
    if voice in BUILTIN_VOICES:
        item = BUILTIN_VOICES[voice]
        return Path(item["path"]), str(item["text"])

    safe_id = re.sub(r"[^a-zA-Z0-9_-]", "", voice)
    manifest = VOICE_ROOT / f"{safe_id}.json"
    if not manifest.exists():
        raise RuntimeError("The selected custom voice is no longer available.")
    data = json.loads(manifest.read_text(encoding="utf-8"))
    path = VOICE_ROOT / data["filename"]
    if not path.exists():
        raise RuntimeError("The custom reference recording is missing.")
    return path, str(data["transcript"])


def load_model() -> Any:
    global model
    if model is None:
        model = AutoModel.from_pretrained(MODEL_ID, trust_remote_code=True)
        model = model.to(torch.device("cuda" if torch.cuda.is_available() else "cpu"))
        model.eval()
    return model


def unload_model() -> None:
    global model
    if model is not None:
        del model
        model = None
    if torch.cuda.is_available():
        torch.cuda.empty_cache()


def synthesize_narration(text: str, reference: Path, reference_text: str, output: Path) -> None:
    tts_model = load_model()
    with torch.inference_mode():
        audio = tts_model(text, ref_audio_path=str(reference), ref_text=reference_text)
    if getattr(audio, "dtype", None) == np.int16:
        audio = audio.astype(np.float32) / 32768.0
    sf.write(str(output), np.asarray(audio, dtype=np.float32), samplerate=24000)


def normalize_segments(tts: dict[str, Any], target: float) -> list[dict[str, Any]]:
    supplied: Any = tts.get("segments")
    if not isinstance(supplied, list):
        encoded = tts.get("segmentsJson")
        if isinstance(encoded, str) and encoded.strip():
            try:
                supplied = json.loads(encoded)
            except json.JSONDecodeError as exc:
                raise RuntimeError("The saved Gemini speaker plan is unreadable.") from exc
    if isinstance(supplied, list) and not supplied:
        labelled_speakers = {
            match.group(1).strip()
            for line in str(tts.get("text", "")).splitlines()
            if (match := re.match(r"^([^:]{1,80}):\s*\S", line.strip()))
        }
        if len(labelled_speakers) > 1:
            raise RuntimeError(
                "This dialogue has multiple speakers but no explicit voice plan; refusing to use one voice for everyone."
            )
    if not isinstance(supplied, list) or not supplied:
        return [{
            "speaker": "Narrator",
            "voice": str(tts.get("voice", "female")),
            "start": 0.0,
            "end": target,
            "text": str(tts.get("text", "")).strip(),
        }]

    result: list[dict[str, Any]] = []
    for index, item in enumerate(supplied):
        if not isinstance(item, dict):
            raise RuntimeError(f"Speaker line {index + 1} is invalid.")
        start = float(item.get("startSeconds", 0))
        end = float(item.get("endSeconds", 0))
        text = str(item.get("text", "")).strip()
        voice = str(item.get("voice", ""))
        speaker = str(item.get("speaker", f"Speaker {index + 1}")).strip()
        if not text or voice not in BUILTIN_VOICES or start < 0 or end <= start or end > target + 0.08:
            raise RuntimeError(f"Speaker line {index + 1} has invalid text, voice, or timing.")
        result.append({"speaker": speaker, "voice": voice, "start": start, "end": min(end, target), "text": text})

    result.sort(key=lambda item: item["start"])
    for index in range(1, len(result)):
        if result[index]["start"] < result[index - 1]["end"] - 0.02:
            raise RuntimeError(f"Speaker lines {index} and {index + 1} overlap.")
    return result


def stored_segment_plan(tts: dict[str, Any]) -> list[dict[str, Any]]:
    encoded = tts.get("segmentsJson")
    if not isinstance(encoded, str) or not encoded.strip():
        return []
    try:
        parsed = json.loads(encoded)
        return parsed if isinstance(parsed, list) else []
    except json.JSONDecodeError:
        return []


def synthesize_timeline(tts: dict[str, Any], target: float, output: Path) -> None:
    sample_rate = 24000
    segments = normalize_segments(tts, target)
    canvas = np.zeros(max(1, int(np.ceil(target * sample_rate))), dtype=np.float32)
    work_dir = STATE_ROOT / f"timeline-{uuid.uuid4().hex}"
    work_dir.mkdir(parents=True, exist_ok=True)
    try:
        for index, segment in enumerate(segments):
            reference, reference_text = resolve_voice_name(segment["voice"])
            raw = work_dir / f"{index:02d}-raw.wav"
            fitted = work_dir / f"{index:02d}-fitted.wav"
            synthesize_narration(segment["text"], reference, reference_text, raw)

            window = max(0.1, segment["end"] - segment["start"])
            speech = max(0.1, media_duration(raw))
            tempo = max(1.0, speech / max(0.1, window - 0.06))
            if tempo > 1.60:
                raise RuntimeError(
                    f'{segment["speaker"]}\'s line is too long ({speech:.1f}s for a {window:.1f}s window). '
                    "Shorten that line or make the video longer."
                )
            filters = ["loudnorm=I=-16:TP=-1.5:LRA=7"]
            if tempo > 1.015:
                filters.append(f"rubberband=tempo={tempo:.5f}")
            filters.extend([f"atrim=0:{window:.5f}", "aresample=24000"])
            run([
                "ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", str(raw),
                "-af", ",".join(filters), "-ac", "1", "-ar", str(sample_rate),
                "-c:a", "pcm_s16le", str(fitted),
            ])
            line, _ = sf.read(str(fitted), dtype="float32", always_2d=False)
            if line.ndim > 1:
                line = line.mean(axis=1)
            maximum = max(1, int(window * sample_rate))
            line = np.asarray(line[:maximum], dtype=np.float32)
            fade = min(len(line) // 2, int(0.018 * sample_rate))
            if fade > 1:
                line[:fade] *= np.linspace(0.0, 1.0, fade, dtype=np.float32)
                line[-fade:] *= np.linspace(1.0, 0.0, fade, dtype=np.float32)
            offset = int(segment["start"] * sample_rate)
            available = min(len(line), len(canvas) - offset)
            if available > 0:
                canvas[offset:offset + available] += line[:available]

        peak = float(np.max(np.abs(canvas)))
        if peak > 0.97:
            canvas *= 0.97 / peak
        sf.write(str(output), canvas, samplerate=sample_rate, subtype="PCM_16")
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)


def mux_tts_variant(original: Path, narration: Path, narrated: Path) -> None:
    """Keep H3's picture, but replace its audio track completely with IndicF5."""
    target = media_duration(original)
    temporary = narrated.with_suffix(".working.mp4")
    run([
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-i", str(original), "-i", str(narration),
        "-filter_complex", f"[1:a]apad,atrim=0:{target:.5f}[voice]",
        "-map", "0:v:0", "-map", "[voice]",
        "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
        "-movflags", "+faststart", "-t", f"{target:.5f}", str(temporary),
    ])
    temporary.replace(narrated)


async def comfy_json(path: str) -> Any:
    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.get(f"{COMFY_URL}{path}")
        response.raise_for_status()
        return response.json()


async def queue_is_idle() -> bool:
    queue = await comfy_json("/queue")
    return not queue.get("queue_running") and not queue.get("queue_pending")


async def release_comfy_models() -> None:
    """Return cached H3 weights to the GPU before loading IndicF5."""
    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.post(
            f"{COMFY_URL}/free",
            json={"unload_models": True, "free_memory": True},
        )
        response.raise_for_status()
    await asyncio.sleep(1)


async def process_entry(prompt_id: str, entry: dict[str, Any], tts: dict[str, Any]) -> None:
    global active_job, last_error
    output = output_video(entry)
    if not output:
        return
    filename, subfolder = output
    original = OUTPUT_ROOT / subfolder / filename
    narrated = original.with_name(f"{original.stem}_tts.mp4")
    narration = original.with_name(f"{original.stem}_tts.wav")
    manifest = original.with_name(f"{original.stem}_tts.json")
    error_file = original.with_name(f"{original.stem}_tts_error.txt")
    if narrated.exists():
        saved_plan: list[dict[str, Any]] = []
        if manifest.exists():
            try:
                saved_plan = json.loads(manifest.read_text(encoding="utf-8")).get("segments", [])
            except (json.JSONDecodeError, OSError, AttributeError):
                saved_plan = []
        completed_jobs[prompt_id] = {"original": filename, "narrated": narrated.name, "subfolder": subfolder, "speakerPlan": saved_plan}
        return
    if not original.exists():
        return

    active_job = prompt_id
    last_error = None
    try:
        await release_comfy_models()
        duration = media_duration(original)
        await asyncio.to_thread(synthesize_timeline, tts, duration, narration)
        await asyncio.to_thread(mux_tts_variant, original, narration, narrated)
        manifest.write_text(
            json.dumps({"segments": stored_segment_plan(tts), "audioMode": "replace"}, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        error_file.unlink(missing_ok=True)
        completed_jobs[prompt_id] = {"original": filename, "narrated": narrated.name, "subfolder": subfolder}
    except Exception as exc:
        last_error = f"{type(exc).__name__}: {exc}"
        error_file.write_text(last_error, encoding="utf-8")
    finally:
        unload_model()
        active_job = None


async def worker() -> None:
    global last_error
    while True:
        try:
            if await queue_is_idle():
                history = await comfy_json("/history?max_items=64")
                if last_error and (
                    last_error.startswith("ConnectError:")
                    or last_error.startswith("HTTPStatusError:")
                ):
                    last_error = None
                candidates: list[tuple[float, str, dict[str, Any], dict[str, Any]]] = []
                for prompt_id, entry in history.items():
                    tts = tts_metadata(entry)
                    if not tts:
                        continue
                    output = output_video(entry)
                    if not output:
                        continue
                    filename, subfolder = output
                    narrated = (OUTPUT_ROOT / subfolder / filename).with_name(
                        f"{Path(filename).stem}_tts.mp4"
                    )
                    if narrated.exists():
                        completed_jobs[prompt_id] = {"original": filename, "narrated": narrated.name, "subfolder": subfolder}
                        continue
                    created = float((entry.get("prompt") or [None, None, None, {}])[3].get("create_time", 0))
                    candidates.append((created, prompt_id, entry, tts))
                if candidates:
                    _, prompt_id, entry, tts = sorted(candidates, key=lambda item: item[0])[0]
                    await process_entry(prompt_id, entry, tts)
        except Exception as exc:
            last_error = f"{type(exc).__name__}: {exc}"
        await asyncio.sleep(POLL_SECONDS)


@app.on_event("startup")
async def start_worker() -> None:
    asyncio.create_task(worker())


@app.get("/health")
async def health() -> dict[str, Any]:
    hf_home = Path(os.environ.get("HF_HOME", Path.home() / ".cache" / "huggingface"))
    model_ready = any((hf_home / "hub" / "models--ai4bharat--IndicF5" / "snapshots").glob("*/config.json"))
    return {
        "online": True,
        "modelReady": model_ready,
        "model": MODEL_ID,
        "device": "cuda" if torch.cuda.is_available() else "cpu",
        "activeJob": active_job,
        "lastError": last_error,
    }


@app.get("/variants")
async def variants() -> dict[str, Any]:
    try:
        history = await comfy_json("/history?max_items=64")
        for prompt_id, entry in history.items():
            if not tts_metadata(entry):
                continue
            output = output_video(entry)
            if not output:
                continue
            filename, subfolder = output
            original = OUTPUT_ROOT / subfolder / filename
            narrated = original.with_name(f"{original.stem}_tts.mp4")
            manifest = original.with_name(f"{original.stem}_tts.json")
            if not narrated.exists():
                continue
            saved_plan: list[dict[str, Any]] = []
            if manifest.exists():
                try:
                    saved_plan = json.loads(manifest.read_text(encoding="utf-8")).get("segments", [])
                except (json.JSONDecodeError, OSError, AttributeError):
                    saved_plan = []
            completed_jobs[prompt_id] = {
                "original": filename,
                "narrated": narrated.name,
                "subfolder": subfolder,
                "speakerPlan": saved_plan,
            }
    except Exception:
        pass
    return {"items": completed_jobs}


@app.post("/voices")
async def upload_voice(audio: UploadFile = File(...), transcript: str = Form(...)) -> dict[str, str]:
    transcript = transcript.strip()
    if not transcript:
        raise HTTPException(status_code=400, detail="A transcript for the reference recording is required.")
    suffix = Path(audio.filename or "voice.wav").suffix.lower()
    if suffix not in {".wav", ".mp3", ".m4a", ".flac", ".ogg"}:
        raise HTTPException(status_code=400, detail="Use a WAV, MP3, M4A, FLAC, or OGG reference recording.")
    voice_id = uuid.uuid4().hex
    stored_name = f"{voice_id}{suffix}"
    destination = VOICE_ROOT / stored_name
    with destination.open("wb") as handle:
        shutil.copyfileobj(audio.file, handle)
    (VOICE_ROOT / f"{voice_id}.json").write_text(
        json.dumps({"filename": stored_name, "transcript": transcript}, ensure_ascii=False),
        encoding="utf-8",
    )
    return {"voiceId": voice_id}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8190)
