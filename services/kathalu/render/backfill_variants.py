"""Give every film that already exists its short and its English versions.

Twelve films were made before any of this existed. Re-rendering them would be days of GPU;
re-cutting them is minutes, because the shots carry no speech and are reused untouched.

Ordered so the cheap work lands first. English is Piper on the CPU and never touches the
graphics card, so every English version of every film is done before the first Telugu short
asks for the GPU -- which matters when she is rendering something new at the same time, as
she usually is.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import variants                                                    # noqa: E402
from pipeline import StoryLock, media_seconds                      # noqa: E402

STORIES = Path("H:/KathaluStudio/stories")

# English first: CPU only, so it cannot be blocked and cannot block anything.
ORDER = [("full", "en"), ("short", "en"), ("short", "te")]


def finished(story_dir: Path) -> bool:
    return (story_dir / "final.mp4").exists() and (story_dir / "script.json").exists()


def aspect_of(story_dir: Path) -> str:
    state = story_dir / "state.json"
    if state.exists():
        try:
            return json.loads(state.read_text(encoding="utf-8")).get("aspect") or "9:16"
        except (json.JSONDecodeError, OSError):
            pass
    return "9:16"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", help="one story folder name, instead of all of them")
    ap.add_argument("--kinds", default="full:en,short:en,short:te",
                    help="which versions, as kind:language pairs")
    ap.add_argument("--voice", default="female", choices=["female", "male"])
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args()

    wanted = [tuple(pair.split(":")) for pair in a.kinds.split(",") if pair.strip()]
    wanted = [(k, l) for k, l in ORDER if (k, l) in wanted]

    stories = [STORIES / a.only] if a.only else sorted(
        d for d in STORIES.iterdir() if d.is_dir() and not d.name.startswith("_"))
    todo = [d for d in stories if finished(d)]
    skipped = [d.name for d in stories if not finished(d)]

    print(f"{len(todo)} finished film(s) to re-cut; {len(skipped)} not finished, left alone")
    if skipped:
        print(f"  skipping: {', '.join(skipped[:6])}{' ...' if len(skipped) > 6 else ''}")
    print()

    started = time.time()
    made, failed = [], []
    # Language outer, story inner: get every CPU version of every film done before anything
    # queues for the graphics card.
    for kind, language in wanted:
        for story_dir in todo:
            out = story_dir / f"final-{language}-{kind}.mp4"
            if out.exists() and not a.force:
                print(f"  {story_dir.name[:34]:34} {language}/{kind:5} already there")
                continue
            try:
                with StoryLock(story_dir):
                    variants.make(story_dir, kind, language, aspect_of(story_dir),
                                  a.voice, a.force)
                made.append(f"{story_dir.name}: {language}/{kind}")
            except SystemExit as exc:
                # A story with no shots on disk, or narration that would not fit. Not fatal
                # to the batch -- the whole point is to get through all of them.
                print(f"  {story_dir.name[:34]:34} {language}/{kind:5} SKIPPED: {exc}")
                failed.append(f"{story_dir.name} {language}/{kind}: {exc}")
            except Exception as exc:                                    # noqa: BLE001
                print(f"  {story_dir.name[:34]:34} {language}/{kind:5} FAILED: "
                      f"{type(exc).__name__}: {exc}")
                failed.append(f"{story_dir.name} {language}/{kind}: {exc}")

    print()
    print(f"made {len(made)} version(s) in {(time.time() - started) / 60:.1f} min")
    for line in failed:
        print(f"  did not work -- {line[:150]}")


if __name__ == "__main__":
    main()
