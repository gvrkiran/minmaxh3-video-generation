"""Kathalu Studio -- the engine. Narration, then video cut to fit it, then one film.

Stages, in the order that matters:

  1. narrate   -- subprocess into the IndicF5 venv, synthesise every scene's Telugu in one
                  model load, measure each wav.
  2. fit       -- choose each shot's frame count from its REAL audio length, snapped up onto
                  H3's 17k+5 grid. This is the whole point of audio-first: the picture is cut
                  to the voice, so the voice is never time-stretched.
  3. render    -- one R2V shot at a time on the one GPU, at 0.4 MP (phase 0: native 1.03 MP
                  pushes the 20 GB of weights into dynamic streaming and costs 20 min/shot
                  instead of 4.6).
  4. mux       -- replace H3's own generated audio with the Telugu narration.
  5. join      -- concatenate into one mp4.

Every stage writes its state to state.json before moving on, and every stage skips work whose
output already exists. Killing this mid-render and starting it again resumes at the next
unfinished shot -- which matters, because a full story is ~40 minutes of GPU.

Usage:
  python pipeline.py --story-dir H:\\KathaluStudio\\stories\\the-fox-and-the-stork
  python pipeline.py --story-dir ... --aspect 16:9 --only-stage render
"""
from __future__ import annotations

import argparse
import functools
import json
import math
import shutil
import subprocess
import sys
import time
import os
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from gpu_lock import GpuLock  # noqa: E402
import comfy_client as comfy  # noqa: E402
import h3_prompt  # noqa: E402
import moral_card  # noqa: E402

LIBRARY = Path(r"H:\KathaluStudio\characters")
INDIC_PY = Path(r"H:\H3RemoteStudio\IndicF5\venv\Scripts\python.exe")
HF_HOME = Path(r"H:\H3RemoteStudio\IndicF5\hf-cache")

MEGAPIXELS = 0.4          # phase 0: the knob that decides whether a shot is 4.6 min or 20
STEPS = 20
FIDELITY = "max"          # phase 0: same cost as "match", better identity
TAIL_PAD = 0.55           # seconds of air after the last syllable
STAGES = ("narrate", "fit", "render", "mux", "join", "variants")

# A 40-minute job whose stdout sits in an 8 KB buffer is a job with no
# diagnostics when it dies. Learned the hard way: two drivers died mid-render
# and left two zero-byte log files.
print = functools.partial(print, flush=True)  # noqa: A001


# ------------------------------------------------------------------ state

def load_state(story_dir: Path) -> dict:
    path = story_dir / "state.json"
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            pass
    return {"stages": {}, "scenes": {}}


def save_state(story_dir: Path, state: dict) -> None:
    state["updatedAt"] = int(time.time() * 1000)
    tmp = story_dir / "state.json.tmp"
    tmp.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(story_dir / "state.json")      # atomic: a kill mid-write cannot corrupt it


def scene_state(state: dict, index: int) -> dict:
    return state["scenes"].setdefault(str(index), {})



# ------------------------------------------------------------------ single-instance lock

class StoryLock:
    """Refuse to run twice against one story.

    Two drivers once ended up queueing the same shots into ComfyUI simultaneously, which
    wastes GPU and races on the output files. The lock records the pid; a stale lock from a
    dead process is reclaimed rather than being a permanent blocker.
    """

    def __init__(self, story_dir: Path):
        self.path = story_dir / "pipeline.lock"

    def _alive(self, pid: int) -> bool:
        out = subprocess.run(["tasklist", "/FI", f"PID eq {pid}", "/NH"],
                             capture_output=True, text=True).stdout
        return str(pid) in out

    def __enter__(self):
        if self.path.exists():
            try:
                held = json.loads(self.path.read_text(encoding="utf-8"))
                pid = int(held.get("pid", -1))
            except (json.JSONDecodeError, ValueError, OSError):
                pid = -1
            if pid > 0 and pid != os.getpid() and self._alive(pid):
                raise SystemExit(
                    f"another pipeline is already working on this story (pid {pid}). "
                    f"if that is wrong, delete {self.path}")
            print(f"  (reclaiming stale lock from pid {pid})")
        self.path.write_text(json.dumps({"pid": os.getpid(), "at": int(time.time())}),
                             encoding="utf-8")
        return self

    def __exit__(self, *exc):
        self.path.unlink(missing_ok=True)
        return False


# ------------------------------------------------------------------ ffmpeg

def run_cmd(args: list[str], attempts: int = 3, cwd: Path | None = None) -> str:
    """Run a tool, retrying a crash.

    This ffmpeg build (gyan.dev 8.0-full) intermittently exits 3221225477
    (0xC0000005, access violation) part-way through a story, and the identical command
    then succeeds on the next attempt. Not worth chasing into ffmpeg; worth retrying,
    because losing a 40-minute render to a one-in-eight segfault is not acceptable.
    """
    last = None
    for attempt in range(1, attempts + 1):
        # cwd matters for ffmpeg's subtitles filter: it parses the filename itself, and a
        # Windows path with a drive letter has to be escaped in a way that varies by build.
        # Running from the file's own directory and naming it plainly sidesteps all of that.
        done = subprocess.run(args, capture_output=True, text=True,
                              encoding="utf-8", errors="replace",
                              cwd=str(cwd) if cwd else None)
        if done.returncode == 0:
            if attempt > 1:
                print(f"      (succeeded on attempt {attempt})")
            return (done.stdout or "").strip()
        # Report the command: a bare 'ffmpeg failed:' with an empty body says nothing,
        # and ffmpeg prints nothing under -loglevel error when it crashes outright.
        shown = " ".join(args)
        last = (
            "exit {} from: {}".format(done.returncode, shown)
            + "\nstderr: " + ((done.stderr or "").strip()[-1200:] or "(empty)")
            + "\nstdout: " + ((done.stdout or "").strip()[-400:] or "(empty)"))
        if attempt < attempts:
            print(f"      (exit {done.returncode}, retrying {attempt + 1}/{attempts})")
            time.sleep(2 * attempt)
    raise RuntimeError(last)


def media_seconds(path: Path) -> float:
    return float(run_cmd(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                          "-of", "default=noprint_wrappers=1:nokey=1", str(path)]))


# ------------------------------------------------------------------ stages

def stage_narrate(story_dir: Path, script_path: Path, voice: str) -> None:
    env_note = f"{INDIC_PY.parent.parent.name} venv"
    print(f"[1/5] narrate  ({env_note}, one model load for the whole story)")
    if not INDIC_PY.exists():
        raise SystemExit(f"IndicF5 interpreter not found: {INDIC_PY}")
    env = {**os.environ, "HF_HOME": str(HF_HOME), "HF_HUB_CACHE": str(HF_HOME / "hub"),
           "HF_HUB_OFFLINE": "1", "PYTHONIOENCODING": "utf-8"}
    done = subprocess.run(
        [str(INDIC_PY), str(Path(__file__).with_name("narrate.py")),
         "--script", str(script_path), "--dir", str(story_dir), "--voice", voice],
        env=env, capture_output=True, text=True, encoding="utf-8", errors="replace")
    for line in (done.stdout or "").splitlines():
        if line.strip():
            print(f"  {line}")
    if done.returncode != 0:
        raise RuntimeError("narration failed:\n" + (done.stderr or "")[-2500:])


def stage_fit(story_dir: Path, script: dict, state: dict) -> dict:
    """Frame count from measured audio, not from the character estimate."""
    print("[2/5] fit      (frames chosen from the measured wav, 17k+5 grid)")
    narration = json.loads((story_dir / "narration.json").read_text(encoding="utf-8"))
    by_index = {n["index"]: n for n in narration["scenes"]}

    fitted = []
    for scene in script["scenes"]:
        n = by_index[scene["index"]]
        needed = n["seconds"] + TAIL_PAD
        frames = h3_prompt.frames_for(needed)
        video_s = h3_prompt.seconds_for(frames)
        short_by = max(0.0, needed - video_s)
        entry = {"index": scene["index"], "audio_seconds": n["seconds"],
                 "frames": frames, "video_seconds": round(video_s, 3),
                 "planned_frames_from_chars": scene["planned_frames"],
                 "audio_exceeds_shot_by": round(short_by, 3)}
        fitted.append(entry)
        st = scene_state(state, scene["index"])
        st.update({"audio_seconds": n["seconds"], "frames": frames})
        flag = ""
        if short_by > 0.01:
            flag = f"  AUDIO {short_by:.2f}s LONGER THAN THE MAX SHOT"
        drift = frames - scene["planned_frames"]
        print(f"  scene {scene['index']:2d}  audio {n['seconds']:6.2f}s -> {frames:3d}f "
              f"({video_s:6.2f}s)  char-estimate was {scene['planned_frames']:3d}f "
              f"({drift:+d}){flag}")
    save_state(story_dir, state)
    return {"scenes": fitted}


def render_one(scene: dict, frames: int, aspect: str, out_path: Path, seed: int) -> dict:
    subjects, refs = [], []
    for key, filename in zip(scene["characters"], scene["reference_images"]):
        record = json.loads((LIBRARY / f"{Path(filename).stem}.json").read_text(encoding="utf-8"))
        subjects.append(record)
        refs.append(comfy.upload_image(LIBRARY / filename, f"kathalu_ref_{Path(filename).stem}.png"))

    prompt = scene["h3_prompt"]
    errors = h3_prompt.validate_prompt(prompt, subjects, scene["telling_mode"])
    if errors:
        raise RuntimeError("refusing to render an invalid prompt:\n  " + "\n  ".join(errors))

    width, height = resolution(aspect, MEGAPIXELS)
    graph = build_r2v(prompt=prompt, refs=refs, width=width, height=height,
                      frames=frames, seed=seed,
                      prefix=f"kathalu-shots/{out_path.stem}")
    result = comfy.run(graph, label=f"scene {scene['index']:2d} {width}x{height} {frames}f",
                       budget_s=3600)
    produced = comfy.output_path(result["files"][0])
    out_path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(produced, out_path)
    return {"seconds": result["seconds"], "raw": str(produced),
            "width": width, "height": height}


def resolution(aspect: str, megapixels: float) -> tuple[int, int]:
    ratios = {"16:9": 16 / 9, "9:16": 9 / 16, "1:1": 1.0, "4:3": 4 / 3}
    ratio = ratios.get(aspect, 9 / 16)
    w = math.sqrt(megapixels * 1_000_000 * ratio)
    h = w / ratio
    scale = min(min(1.0, 1344 / max(w, h)), min(1.0, 768 / min(w, h)))
    return (max(256, math.ceil(w * scale / 32) * 32),
            max(256, math.ceil(h * scale / 32) * 32))


def build_r2v(*, prompt: str, refs: list[str], width: int, height: int, frames: int,
              seed: int, prefix: str) -> dict:
    graph = {
        "1": {"inputs": {"vae_name": "minimax_h3_video_vae_fp16.safetensors"},
              "class_type": "VAELoader", "_meta": {"title": "Video VAE"}},
        "2": {"inputs": {"vae_name": "minimax_h3_audio_vae_fp32.safetensors"},
              "class_type": "VAELoader", "_meta": {"title": "Audio VAE"}},
        "3": {"inputs": {"unet_name": "minimax_h3_ref2va_pruned_int8_convrot.safetensors",
                         "weight_dtype": "default"},
              "class_type": "UNETLoader", "_meta": {"title": "MiniMax H3 R2V"}},
        "4": {"inputs": {"clip_name": "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
                         "type": "minimax", "device": "default"},
              "class_type": "CLIPLoader", "_meta": {"title": "H3 Text Encoder"}},
        "5": {"inputs": {"noise_seed": seed},
              "class_type": "RandomNoise", "_meta": {"title": "Seed"}},
        "6": {"inputs": {"prompt": prompt, "width": width, "height": height,
                         "length": frames, "clip": ["4", 0], "vae": ["1", 0],
                         "audio_vae": ["2", 0], "ref_image_size": FIDELITY,
                         "ref_images": {f"ref_image_{i + 1}": [str(15 + i), 0]
                                        for i in range(len(refs))}},
              "class_type": "MiniMaxH3ReferenceToVideo",
              "_meta": {"title": "H3 Reference to Video"}},
        "7": {"inputs": {"model": ["3", 0], "conditioning": ["6", 0]},
              "class_type": "BasicGuider", "_meta": {"title": "Guider"}},
        "8": {"inputs": {"sampler_name": "res_multistep"},
              "class_type": "KSamplerSelect", "_meta": {"title": "Sampler"}},
        "9": {"inputs": {"scheduler": "simple", "steps": STEPS, "denoise": 1,
                         "model": ["3", 0]},
              "class_type": "BasicScheduler", "_meta": {"title": "Schedule"}},
        "10": {"inputs": {"noise": ["5", 0], "guider": ["7", 0], "sampler": ["8", 0],
                          "sigmas": ["9", 0], "latent_image": ["6", 1]},
               "class_type": "SamplerCustomAdvanced", "_meta": {"title": "Generate"}},
        "11": {"inputs": {"samples": ["10", 0], "vae": ["1", 0]},
               "class_type": "VAEDecode", "_meta": {"title": "Decode Video"}},
        "12": {"inputs": {"samples": ["10", 0], "vae": ["2", 0]},
               "class_type": "VAEDecodeAudio", "_meta": {"title": "Decode Audio"}},
        "13": {"inputs": {"fps": 24, "bit_depth": 8, "images": ["11", 0], "audio": ["12", 0]},
               "class_type": "CreateVideo", "_meta": {"title": "Create Video"}},
        "14": {"inputs": {"filename_prefix": prefix, "format": "auto", "codec": "auto",
                          "video": ["13", 0]},
               "class_type": "SaveVideo", "_meta": {"title": "Save Video"}},
    }
    for i, ref in enumerate(refs):
        graph[str(15 + i)] = {"inputs": {"image": ref}, "class_type": "LoadImage",
                              "_meta": {"title": f"Character reference {i + 1}"}}
    return graph


def stage_render(story_dir: Path, script: dict, fit: dict, aspect: str, state: dict) -> None:
    by_index = {f["index"]: f for f in fit["scenes"]}
    shots_dir = story_dir / "shots"
    shots_dir.mkdir(parents=True, exist_ok=True)
    pending = [s for s in script["scenes"]
               if not (shots_dir / f"scene_{s['index']:02d}.mp4").exists()]
    print(f"[3/5] render   ({len(pending)} of {len(script['scenes'])} shot(s) to go, "
          f"~4.6 min each at {MEGAPIXELS} MP)")

    for scene in script["scenes"]:
        out = shots_dir / f"scene_{scene['index']:02d}.mp4"
        st = scene_state(state, scene["index"])
        if out.exists():
            print(f"  scene {scene['index']:2d}  cached")
            st["video"] = str(out)
            continue
        frames = by_index[scene["index"]]["frames"]
        # The seed follows how many times this scene has been redone. A fixed seed would
        # make "redo this scene" with no note reproduce the identical shot -- the same trap
        # that made the portrait "Try again" button look like it did nothing.
        redos = int(st.get("redo_count", 0))
        info = render_one(scene, frames, aspect, out,
                          seed=7000 + scene["index"] + 1300 * redos)
        st.update({"video": str(out), "render_seconds": info["seconds"],
                   "size": [info["width"], info["height"]]})
        save_state(story_dir, state)          # after EVERY shot, so a kill loses at most one


def stage_mux(story_dir: Path, script: dict, state: dict) -> None:
    """Replace H3's own audio with the Telugu narration, padded to the shot length."""
    print("[4/5] mux      (H3's generated audio replaced by the narration)")
    out_dir = story_dir / "narrated"
    out_dir.mkdir(parents=True, exist_ok=True)
    for scene in script["scenes"]:
        idx = scene["index"]
        out = out_dir / f"scene_{idx:02d}.mp4"
        st = scene_state(state, idx)
        if out.exists():
            print(f"  scene {idx:2d}  cached")
            st["narrated"] = str(out)
            continue
        video = story_dir / "shots" / f"scene_{idx:02d}.mp4"
        wav = story_dir / "narration" / f"scene_{idx:02d}.wav"
        target = media_seconds(video)
        run_cmd(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                 "-i", str(video), "-i", str(wav),
        # No loudnorm here: IndicF5's output already measures a consistent
        # RMS near 0.100 and narrate.py peak-limits it, and loudnorm was
        # implicated in the intermittent ffmpeg crash.
                 "-filter_complex",
                 f"[1:a]apad,atrim=0:{target:.5f}[voice]",
                 "-map", "0:v:0", "-map", "[voice]",
                 "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
                 "-movflags", "+faststart", "-t", f"{target:.5f}", str(out)])
        st["narrated"] = str(out)
        save_state(story_dir, state)
        print(f"  scene {idx:2d}  {target:6.2f}s  narrated")


def stage_moral(story_dir: Path, script: dict, aspect: str, state: dict) -> Path | None:
    """The closing card. A still plus the narrated moral -- seconds of ffmpeg rather than
    minutes of GPU, and the text comes out actually readable."""
    telugu = (script.get("telugu_moral") or "").strip()
    audio = story_dir / "narration" / "moral.wav"
    if not telugu or not audio.exists():
        print("[4b/5] moral   (no moral to show, skipping)")
        return None
    out = story_dir / "narrated" / "zz_moral.mp4"
    if out.exists():
        print("[4b/5] moral   cached")
        return out
    width, height = resolution(aspect, MEGAPIXELS)
    moral_card.build_segment(
        telugu=telugu, english=(script.get("moral_english") or "").strip(),
        audio=audio, width=width, height=height, out=out, run_cmd=run_cmd)
    state["moral"] = {"video": str(out), "source": script.get("moral_source")}
    save_state(story_dir, state)
    print(f"[4b/5] moral   {media_seconds(out):.2f}s  ({script.get('moral_source', '?')})")
    return out


def stage_join(story_dir: Path, script: dict, state: dict) -> Path:
    print("[5/5] join     (one file)")
    listing = story_dir / "concat.txt"
    parts = [story_dir / "narrated" / f"scene_{s['index']:02d}.mp4" for s in script["scenes"]]
    moral = story_dir / "narrated" / "zz_moral.mp4"
    if moral.exists():
        parts.append(moral)
    listing.write_text(
        "".join(f"file '{p.as_posix()}'\n" for p in parts), encoding="utf-8")
    final = story_dir / "final.mp4"
    # Re-encode rather than -c copy: concat of separately-encoded H.264 with fresh AAC is
    # far more reliably seekable, and one pass over ~90 s costs a couple of seconds.
    run_cmd(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
             "-f", "concat", "-safe", "0", "-i", str(listing),
             "-c:v", "libx264", "-preset", "medium", "-crf", "19",
             "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k",
             "-movflags", "+faststart", str(final)])
    state["final"] = str(final)
    save_state(story_dir, state)
    return final


def stage_variants(story_dir: Path, script: dict, aspect: str, voice: str) -> list[str]:
    """The other three cuts: a Telugu short, and English in both lengths.

    Cheap, because the shots carry no speech and are reused as they are -- no scene is
    rendered twice. Imported here rather than at the top because variants.py imports this
    module for its ffmpeg helpers, and at module scope that is a cycle.

    Done inside the render's existing GPU lock deliberately. The Telugu voice model is a GPU
    model, so acquiring the card once for the film and its Telugu short beats releasing it
    and queueing again. English is Piper on the CPU and would not need the lock at all.
    """
    import variants

    print("[6/6] versions (short and English, reusing the shots that already exist)")
    made = []
    for kind, language in (("short", "te"), ("full", "en"), ("short", "en")):
        try:
            out = variants.make(story_dir, kind, language, aspect, voice)
            made.append(out.name)
        except Exception as exc:                                        # noqa: BLE001
            # One version failing must not lose the film that was just made. Say so and
            # carry on -- she can ask for it again from the editor.
            print(f"  {language}/{kind} did not work: {type(exc).__name__}: {exc}",
                  flush=True)
    return made


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--story-dir", required=True)
    ap.add_argument("--script", help="defaults to <story-dir>/script.json")
    ap.add_argument("--aspect", default="9:16", choices=["9:16", "16:9"])
    ap.add_argument("--voice", default="female", choices=["female", "male"])
    ap.add_argument("--only-stage", choices=STAGES)
    a = ap.parse_args()

    story_dir = Path(a.story_dir)
    story_dir.mkdir(parents=True, exist_ok=True)
    script_path = Path(a.script) if a.script else story_dir / "script.json"
    script = json.loads(script_path.read_text(encoding="utf-8"))
    state = load_state(story_dir)
    state.setdefault("aspect", a.aspect)
    wanted = [a.only_stage] if a.only_stage else list(STAGES)

    started = time.time()
    # The per-story lock stops two drivers on ONE story. This one stops two stories from
    # using the card at the same time -- a 24 GB 4090 cannot hold two of these stacks, and
    # the voice model in particular loads outside ComfyUI's queue where nothing serialises
    # it. Held across the whole render rather than per shot, because reloading these weights
    # costs far more than waiting for them.
    with StoryLock(story_dir), GpuLock("making the video",
                                       story=script.get("title") or story_dir.name):
        print(f"{script.get('title') or story_dir.name}  |  {len(script['scenes'])} scenes  "
              f"|  {a.aspect}  |  {story_dir}\n")

        if "narrate" in wanted:
            stage_narrate(story_dir, script_path, a.voice)
            state["stages"]["narrate"] = "done"
            save_state(story_dir, state)

        fit_path = story_dir / "fit.json"
        fit = None
        if "fit" in wanted:
            fit = stage_fit(story_dir, script, state)
            fit_path.write_text(json.dumps(fit, indent=2), encoding="utf-8")
            state["stages"]["fit"] = "done"
            save_state(story_dir, state)
        elif "render" in wanted:
            # only the render stage needs the fit; don't demand it for --only-stage narrate
            if not fit_path.exists():
                raise SystemExit(f"{fit_path} is missing -- run the fit stage first")
            fit = json.loads(fit_path.read_text(encoding="utf-8"))

        if "render" in wanted:
            stage_render(story_dir, script, fit, state.get("aspect", a.aspect), state)
            state["stages"]["render"] = "done"
            save_state(story_dir, state)
        if "mux" in wanted:
            stage_mux(story_dir, script, state)
            state["stages"]["mux"] = "done"
            save_state(story_dir, state)
        if "mux" in wanted or "join" in wanted:
            stage_moral(story_dir, script, state.get("aspect", a.aspect), state)
        if "join" in wanted:
            final = stage_join(story_dir, script, state)
            state["stages"]["join"] = "done"
            save_state(story_dir, state)
            print(f"\n{final}  {media_seconds(final):.2f}s  "
                  f"{final.stat().st_size / 1024 ** 2:.1f} MB")

        if "variants" in wanted:
            made = stage_variants(story_dir, script, a.aspect, a.voice)
            state["stages"]["variants"] = "done"
            state["variants"] = made
            save_state(story_dir, state)
            if made:
                print("  also made: " + ", ".join(made))

    print(f"\ntotal {(time.time() - started) / 60:.1f} min")


if __name__ == "__main__":
    main()
