"""Voice API: one HTTP endpoint that speaks English in four accents.

    POST /tts   {"voice": "middle_eastern", "text": "..."}  ->  audio/wav bytes
    GET  /voices                                            ->  what you can ask for
    GET  /health                                            ->  is it up, what is warm

WHY IT LOOKS LIKE THIS

The four voices run on three different engines, and the engines cannot share a Python process:
Maya1 needs transformers 5.x, Afro-TTS needs 4.49.0, Chatterbox pins its own. So each engine
lives in its own venv and is driven as a child process over stdin/stdout, one JSON job per line
-- the same shape `_speak_indicspeak.py` already uses in Kathalu.

Only ONE engine is kept loaded at a time, and it holds the machine-wide Kathalu GPU lock for as
long as it stays warm. That is deliberate. This card is 24 GB and an H3 render stages about 20 GB,
so a resident Maya1 (6.7 GB) on top of a running film is an out-of-memory crash, not a slowdown.
Holding the lock means her film waits at most IDLE_UNLOAD_S for the voice, and the voice waits
politely rather than crashing her render. Switching voices between engines costs a model reload
(8-35 s); repeat calls to the same voice are warm and fast.
"""
from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import threading
import time
import uuid
from collections import deque
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field

# The code lives in the repo; everything it WRITES lives outside it, beside the venv and the
# model weights. Same split the indicf5 service uses -- generated audio must not land in git.
ROOT = Path(__file__).parent
DATA_ROOT = Path(os.environ.get("VOICEAPI_DATA", "H:/H3RemoteStudio/VoiceAPI"))

VOICES = json.loads((ROOT / "voices.json").read_text(encoding="utf-8"))
VOICES = {k: v for k, v in VOICES.items() if not k.startswith("_")}
OUT_DIR = Path(os.environ.get("VOICEAPI_OUT", DATA_ROOT / "out"))
OUT_DIR.mkdir(parents=True, exist_ok=True)

# Each engine: which python runs it, and which worker script it runs.
#
# Every engine gets its OWN HF_HOME and TEMP, set explicitly rather than inherited. This is not
# tidiness: start-h3-studio.ps1 sets HF_HOME and TEMP to IndicF5's paths for the narration service
# and never resets them, so a worker launched from that script would silently inherit another
# model's cache directory. That cost an afternoon -- the Afro-TTS worker loaded in 14 s by hand
# and hung past its timeout when the scheduled task started it.
TMP_DIR = DATA_ROOT / "tmp"
TMP_DIR.mkdir(parents=True, exist_ok=True)

ENGINES = {
    "maya1": {
        "python": "H:/H3RemoteStudio/IndicSpeak/venv/Scripts/python.exe",
        "script": str(ROOT / "workers" / "maya1_worker.py"),
        "env": {"HF_HUB_OFFLINE": "1", "HF_HOME": "H:/H3RemoteStudio/Maya1/hf-cache"},
        "load_s": 120,
    },
    "chatterbox": {
        "python": "H:/H3RemoteStudio/Chatterbox/venv/Scripts/python.exe",
        "script": str(ROOT / "workers" / "chatterbox_worker.py"),
        "env": {"HF_HUB_OFFLINE": "1", "HF_HOME": "H:/H3RemoteStudio/Chatterbox/hf-cache"},
        "load_s": 120,
    },
    "afrotts": {
        "python": "H:/H3RemoteStudio/AfroTTS/venv/Scripts/python.exe",
        "script": str(ROOT / "workers" / "afrotts_worker.py"),
        "env": {"HF_HUB_OFFLINE": "1", "HF_HOME": "H:/H3RemoteStudio/AfroTTS/hf-cache"},
        "load_s": 120,
    },
}

IDLE_UNLOAD_S = int(os.environ.get("VOICEAPI_IDLE_UNLOAD_S", "180"))
GPU_WAIT_S = int(os.environ.get("VOICEAPI_GPU_WAIT_S", "600"))
GEN_TIMEOUT_S = int(os.environ.get("VOICEAPI_GEN_TIMEOUT_S", "300"))
GPU_LOCK = Path(os.environ.get("KATHALU_GPU_LOCK", "H:/KathaluStudio/gpu.lock"))
COMFY = os.environ.get("COMFY_URL", "http://127.0.0.1:8188")

app = FastAPI(title="Voice API", version="1.0")


class Speak(BaseModel):
    voice: str = Field(..., description="accent (indian|american|african|middle_eastern), "
                                        "optionally with _male/_female")
    text: str = Field(..., min_length=1, max_length=5000)
    gender: str | None = Field(None, description="male | female")
    seed: int = 1234
    keep: bool = Field(False, description="keep the wav on disk and return JSON instead of audio")


# What an accent name alone resolves to. These are the voices Kiran originally picked, kept as the
# defaults so calls written before gender existed keep returning the same voice they always did.
DEFAULT_GENDER = {
    "indian": "male", "american": "male", "african": "male", "middle_eastern": "female",
}
ACCENTS = sorted({v["accent"] for v in VOICES.values()})
GENDERS = ("male", "female")


def resolve_voice(name: str, gender: str | None) -> tuple[str, dict]:
    """Accept 'indian_female', or 'indian' plus gender='female', or bare 'indian'."""
    name = (name or "").strip().lower()
    gender = (gender or "").strip().lower() or None
    if gender and gender not in GENDERS:
        raise HTTPException(status_code=400, detail={
            "error": f"unknown gender {gender!r}", "available": list(GENDERS)})

    if name in VOICES:                      # already a full key, e.g. indian_female
        if gender and VOICES[name]["gender"] != gender:
            raise HTTPException(status_code=400, detail={
                "error": f"{name!r} is {VOICES[name]['gender']}, but gender={gender!r} was asked for",
                "hint": f"use voice='{VOICES[name]['accent']}' with gender='{gender}'"})
        return name, VOICES[name]

    if name in ACCENTS:                     # an accent, plus gender or the default
        key = f"{name}_{gender or DEFAULT_GENDER.get(name, 'male')}"
        if key in VOICES:
            return key, VOICES[key]

    raise HTTPException(status_code=400, detail={
        "error": f"unknown voice {name!r}",
        "accents": ACCENTS, "genders": list(GENDERS),
        "voices": sorted(VOICES),
        "hint": "send voice='african' with gender='female', or voice='african_female'",
    })


# ---------------------------------------------------------------- GPU lock (shared with Kathalu)

def _pid_alive(pid: int) -> bool:
    out = subprocess.run(["tasklist", "/FI", f"PID eq {pid}", "/NH"],
                         capture_output=True, text=True).stdout
    return str(pid) in out


def gpu_holder() -> dict | None:
    """Who holds the machine-wide GPU lock, or None if free/stale. Same file Kathalu uses."""
    try:
        held = json.loads(GPU_LOCK.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return None
    pid = int(held.get("pid", -1))
    if pid <= 0 or not _pid_alive(pid):
        return None
    return held


def take_gpu_lock(pid: int, label: str) -> None:
    GPU_LOCK.parent.mkdir(parents=True, exist_ok=True)
    GPU_LOCK.write_text(json.dumps({
        "pid": pid, "label": label, "story": "voice-api", "at": int(time.time()),
    }), encoding="utf-8")


def drop_gpu_lock(pid: int) -> None:
    try:
        held = json.loads(GPU_LOCK.read_text(encoding="utf-8"))
        if int(held.get("pid", -1)) == pid:
            GPU_LOCK.unlink(missing_ok=True)
    except (FileNotFoundError, json.JSONDecodeError, OSError, ValueError):
        pass


async def free_comfy() -> None:
    """Ask ComfyUI to drop its weights before we put a model on the card."""
    try:
        import urllib.request
        req = urllib.request.Request(
            f"{COMFY}/free", data=json.dumps({"unload_models": True, "free_memory": True}).encode(),
            headers={"Content-Type": "application/json"}, method="POST")
        await asyncio.to_thread(lambda: urllib.request.urlopen(req, timeout=20).read())
    except Exception:
        pass  # ComfyUI not running is fine; it just means the card is already free of it


# ---------------------------------------------------------------- the one warm worker

class Worker:
    """A loaded engine in its own venv, held warm, holding the GPU lock while it lives."""

    def __init__(self, engine: str):
        self.engine = engine
        spec = ENGINES[engine]
        env = {**os.environ, **spec.get("env", {}),
               "TEMP": str(TMP_DIR), "TMP": str(TMP_DIR),
               "HF_HUB_DISABLE_TELEMETRY": "1"}
        env.pop("HF_HUB_CACHE", None)   # would override the per-engine HF_HOME set above
        self.proc = subprocess.Popen(
            [spec["python"], "-u", spec["script"]],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding="utf-8", env=env, cwd=str(ROOT))
        self.last_used = time.time()
        self.ready = False

        # Drain stderr continuously into a small ring buffer. This is not for the logging: a
        # pipe nobody reads fills at about 64 KB and then the WRITER BLOCKS. These libraries are
        # chatty on load (deprecation warnings, progress bars), so an undrained stderr wedges the
        # worker mid-import and it looks exactly like a model that died. Keep this thread.
        self.errlog: deque[str] = deque(maxlen=200)
        self._drain = threading.Thread(target=self._drain_stderr, daemon=True)
        self._drain.start()

    def _drain_stderr(self) -> None:
        try:
            for line in self.proc.stderr:
                self.errlog.append(line.rstrip())
        except Exception:
            pass

    def recent_errors(self, limit: int = 12) -> str:
        return "\n".join(list(self.errlog)[-limit:])

    async def _read_json_line(self, timeout_s: int) -> dict:
        """Next JSON object the worker prints, skipping any chatter these libraries emit first."""
        deadline = time.time() + timeout_s
        while True:
            remaining = deadline - time.time()
            if remaining <= 0:
                raise asyncio.TimeoutError()
            line = await asyncio.wait_for(asyncio.to_thread(self.proc.stdout.readline), remaining)
            if not line:
                raise RuntimeError(
                    f"{self.engine} worker exited (code {self.proc.poll()}): {self.recent_errors()}")
            line = line.strip()
            if line.startswith("{"):
                try:
                    return json.loads(line)
                except json.JSONDecodeError:
                    continue

    async def wait_ready(self, timeout_s: int) -> None:
        msg = await self._read_json_line(timeout_s)
        if not msg.get("ok"):
            raise RuntimeError(f"{self.engine} worker failed to load: {msg}")
        self.ready = True

    async def run(self, job: dict, timeout_s: int) -> dict:
        self.proc.stdin.write(json.dumps(job) + "\n")
        self.proc.stdin.flush()
        result = await self._read_json_line(timeout_s)
        self.last_used = time.time()
        return result

    def stop(self) -> None:
        try:
            self.proc.stdin.close()
        except Exception:
            pass
        try:
            self.proc.wait(timeout=10)
        except Exception:
            self.proc.kill()
        drop_gpu_lock(self.proc.pid)


current: Worker | None = None
busy = asyncio.Lock()          # one generation at a time; the card can only do one anyway


async def ensure_worker(engine: str) -> Worker:
    """Return a warm worker for this engine, swapping engines (and the GPU) if needed."""
    global current
    if current and current.engine == engine and current.proc.poll() is None:
        return current

    if current:                                     # different engine, or it died
        await asyncio.to_thread(current.stop)
        current = None

    # Wait for the card. Her film renders hold this same lock, and waiting beats an OOM.
    started = time.time()
    while (held := gpu_holder()) is not None:
        if time.time() - started > GPU_WAIT_S:
            raise HTTPException(status_code=503, detail={
                "error": "The GPU is busy and did not free up in time.",
                "heldBy": held.get("label"), "forStory": held.get("story"),
                "hint": "A video is rendering. Try again when it finishes.",
            })
        await asyncio.sleep(5)

    # Loading a model onto a card that something else just let go of is occasionally flaky, so
    # one retry rather than handing the caller a 500 for a hiccup it cannot do anything about.
    last_error: Exception | None = None
    for attempt in (1, 2):
        await free_comfy()
        worker = Worker(engine)
        take_gpu_lock(worker.proc.pid, f"voice-api ({engine})")
        try:
            await worker.wait_ready(ENGINES[engine]["load_s"] + 60)
        except Exception as caught:
            last_error = caught
            await asyncio.to_thread(worker.stop)
            print(f"[voice-api] {engine} failed to load (attempt {attempt}): {caught}", flush=True)
            if attempt == 1:
                await asyncio.sleep(3)
            continue
        current = worker
        return worker

    raise HTTPException(status_code=500, detail={
        "error": f"the {engine} voice failed to load twice",
        "detail": str(last_error)[:800],
    })


async def idle_reaper() -> None:
    """Let go of the card when nobody has asked for a while."""
    global current
    while True:
        await asyncio.sleep(10)
        if current and time.time() - current.last_used > IDLE_UNLOAD_S and not busy.locked():
            await asyncio.to_thread(current.stop)
            current = None


@app.on_event("startup")
async def _startup() -> None:
    asyncio.create_task(idle_reaper())


@app.on_event("shutdown")
async def _shutdown() -> None:
    global current
    if current:
        await asyncio.to_thread(current.stop)
        current = None


# ---------------------------------------------------------------- endpoints

@app.get("/health")
async def health():
    held = gpu_holder()
    return {
        "ok": True,
        "voices": sorted(VOICES),
        "warm": current.engine if current and current.proc.poll() is None else None,
        "gpuHeldBy": (held or {}).get("label"),
        "idleUnloadSeconds": IDLE_UNLOAD_S,
    }


@app.get("/voices")
async def voices():
    return {
        "accents": ACCENTS,
        "genders": list(GENDERS),
        "howToAsk": "voice='african' with gender='female', or voice='african_female'",
        "defaultGenderWhenOmitted": DEFAULT_GENDER,
        "voices": {
            name: {
                "accent": v["accent"],
                "gender": v["gender"],
                "engine": v["engine"],
                "label": v.get("label", ""),
                "sounds_like": v.get("reference_note",
                                     "designed from a text description, no reference audio"),
            }
            for name, v in sorted(VOICES.items())
        },
    }


@app.post("/tts")
async def tts(req: Speak):
    voice_key, voice = resolve_voice(req.voice, req.gender)
    engine = voice["engine"]
    out_path = OUT_DIR / f"{voice_key}_{uuid.uuid4().hex[:12]}.wav"
    job = {"text": req.text, "out": str(out_path), "seed": req.seed}
    if engine == "maya1":
        job |= {"description": voice["description"],
                "temperature": voice.get("temperature", 0.4),
                "repetition_penalty": voice.get("repetition_penalty", 1.1)}
    else:
        ref = voice["reference"]
        if not Path(ref).exists():
            raise HTTPException(status_code=500, detail={
                "error": f"reference clip missing for {voice_key}", "path": ref})
        job |= {"reference": ref}
        if engine == "chatterbox":
            job |= {"exaggeration": voice.get("exaggeration", 0.5),
                    "cfg_weight": voice.get("cfg_weight", 0.5)}
        else:
            job |= {"gpt_cond_len": voice.get("gpt_cond_len", 6),
                    "temperature": voice.get("temperature", 0.75)}

    async with busy:
        worker = await ensure_worker(engine)
        try:
            result = await worker.run(job, GEN_TIMEOUT_S)
        except asyncio.TimeoutError:
            global current
            await asyncio.to_thread(worker.stop)
            current = None
            raise HTTPException(status_code=504, detail={"error": "generation timed out"})

    if not result.get("ok"):
        raise HTTPException(status_code=500, detail={
            "error": result.get("error", "generation failed"), "voice": voice_key, "engine": engine})

    if req.keep:
        return JSONResponse({
            "ok": True, "voice": voice_key, "accent": voice["accent"], "gender": voice["gender"],
            "engine": engine, "path": str(out_path),
            "seconds": result.get("seconds"), "sampleRate": result.get("sample_rate"),
            "generationSeconds": result.get("wall"),
        })

    return FileResponse(
        out_path, media_type="audio/wav", filename=out_path.name,
        headers={
            "X-Voice": voice_key, "X-Accent": voice["accent"], "X-Gender": voice["gender"],
            "X-Engine": engine,
            "X-Audio-Seconds": str(result.get("seconds")),
            "X-Generation-Seconds": str(result.get("wall")),
        })


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host=os.environ.get("VOICEAPI_HOST", "127.0.0.1"),
                port=int(os.environ.get("VOICEAPI_PORT", "8200")), log_level="info")
