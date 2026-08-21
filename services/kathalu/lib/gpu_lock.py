"""One GPU, one job at a time -- across stories, not just within one.

There was already a per-story lock, which stops two drivers fighting over the same story.
It does nothing about two DIFFERENT stories, and Kiran asked the right question: what happens
if she opens a few tabs and starts several at once.

Measured on this machine: an RTX 4090 with 24,564 MB, and H3 alone stages about 20,000 MB of
weights. So two GPU stages do not fit, and the parts of the pipeline that touch the GPU are
not equally protected:

  * Portraits and shots go through ComfyUI's /prompt endpoint, and ComfyUI runs its queue
    one graph at a time. Those were already safe from a collision.
  * The voice does NOT. narrate.py loads IndicF5 straight onto CUDA inside its own venv,
    outside ComfyUI entirely, so two stories narrating at once put two torch models on the
    card with whatever ComfyUI is already holding. That is a real out-of-memory path.
  * Worse, and quietly: free_models() posts /free with unload_models, which unloads
    EVERYTHING. One story finishing its portraits evicts the H3 weights another story is
    half-way through rendering with, and every remaining shot then pays a full reload.
    Nothing crashes; it just takes several times longer for no visible reason.

Hence a lock that spans stories. It WAITS rather than failing, because from her side "your
video is waiting for the other one to finish" is a queue, and an error is a wall.

Held coarsely, for a whole stage rather than each item. That is deliberate: reloading these
weights costs more than waiting for them. A shot renders in 4.6 minutes with the model
resident and around 20 with it streaming, so letting another story cut in between shots would
be slower for both than making it wait its turn.
"""
from __future__ import annotations

import json
import os
import subprocess
import time
from pathlib import Path

# Beside the stories rather than inside any one of them, because it belongs to the machine.
LOCK_PATH = Path(os.environ.get("KATHALU_GPU_LOCK", "H:/KathaluStudio/gpu.lock"))

POLL_S = 5
# A whole film is about 40 minutes, so a story queued behind one has to be prepared to wait
# longer than that before we call the holder wedged.
DEFAULT_TIMEOUT_S = 5400


def _alive(pid: int) -> bool:
    out = subprocess.run(["tasklist", "/FI", f"PID eq {pid}", "/NH"],
                         capture_output=True, text=True).stdout
    return str(pid) in out


def _holder() -> dict | None:
    """Who holds the lock, or None if it is free or the holder is dead."""
    try:
        held = json.loads(LOCK_PATH.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return None
    pid = int(held.get("pid", -1))
    if pid <= 0 or pid == os.getpid() or not _alive(pid):
        return None
    return held


class GpuLock:
    """Wait for exclusive use of the GPU, then release it.

    `label` is what another waiting story prints while it waits, so a stuck queue says which
    story and which stage is holding things up rather than just hanging.
    """

    def __init__(self, label: str, story: str = "", timeout_s: int = DEFAULT_TIMEOUT_S):
        self.label = label
        self.story = story
        self.timeout_s = timeout_s
        self.waited = 0.0

    def __enter__(self) -> "GpuLock":
        started = time.time()
        announced = False
        while (held := _holder()) is not None:
            if time.time() - started > self.timeout_s:
                raise SystemExit(
                    f"waited {self.timeout_s}s for the GPU, still held by pid "
                    f"{held.get('pid')} doing {held.get('label')!r} for "
                    f"{held.get('story')!r}. If that job is gone, delete {LOCK_PATH}")
            if not announced:
                # Printed once, and it lands in the story log, which is where the progress
                # reader looks -- so the screen can say why nothing appears to be happening.
                print(f"  WAITING FOR GPU: {held.get('label')} is running for "
                      f"{held.get('story') or 'another story'}. Yours starts when it "
                      f"finishes.", flush=True)
                announced = True
            time.sleep(POLL_S)

        self.waited = round(time.time() - started, 1)
        LOCK_PATH.parent.mkdir(parents=True, exist_ok=True)
        LOCK_PATH.write_text(json.dumps({
            "pid": os.getpid(), "label": self.label,
            "story": self.story, "at": int(time.time()),
        }), encoding="utf-8")
        if self.waited >= POLL_S:
            print(f"  (got the GPU after waiting {self.waited}s)", flush=True)
        return self

    def __exit__(self, *exc) -> bool:
        # Only drop it if it is still ours. A reclaimed-stale case must not delete the lock
        # belonging to whoever reclaimed it.
        try:
            held = json.loads(LOCK_PATH.read_text(encoding="utf-8"))
            if int(held.get("pid", -1)) == os.getpid():
                LOCK_PATH.unlink(missing_ok=True)
        except (FileNotFoundError, json.JSONDecodeError, OSError, ValueError):
            pass
        return False


def whos_using_it() -> dict | None:
    """For a status screen: who holds the GPU, or None."""
    return _holder()
