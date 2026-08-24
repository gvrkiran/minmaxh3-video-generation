"""Put subtitles on the English films that were made before subtitles existed.

Twenty-six English videos were built, and then subtitles were added to the pipeline, so none
of them had any. This does not re-synthesise anything: the words and the timings are already
on disk -- the cut plan says what is said over each shot, and the muxed pieces say exactly
how long each one runs -- so it is an ffmpeg pass and nothing more.

It reads the lengths from the pieces rather than recomputing them, because a short's shots
were trimmed to their narration and only the files know the result.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "lib"))

import subtitles                                                   # noqa: E402
from pipeline import MEGAPIXELS, media_seconds, resolution, run_cmd  # noqa: E402

STORIES = Path("H:/KathaluStudio/stories")


def already_subtitled(video: Path) -> bool:
    """A film built by the current pipeline has its .srt beside it and the words burned in."""
    return video.with_suffix(".srt").exists()


def segments_for(story_dir: Path, kind: str) -> list[tuple[str, float]] | None:
    """(what is said, how long it runs) for every piece, in the order they were joined."""
    work = story_dir / "variants" / f"en-{kind}"
    plan = work / "cut.json"
    if not plan.exists():
        return None
    cut = json.loads(plan.read_text(encoding="utf-8"))
    narrated = work / "narrated"
    segments: list[tuple[str, float]] = []
    for beat in cut.get("beats", []):
        piece = narrated / f"scene_{beat['scene']:02d}.mp4"
        if not piece.exists():
            return None
        segments.append((beat["narration"], media_seconds(piece)))
    card = narrated / "zz_moral.mp4"
    if (cut.get("moral") or "").strip() and card.exists():
        segments.append((cut["moral"], media_seconds(card)))
    return segments or None


def aspect_of(story_dir: Path) -> str:
    state = story_dir / "state.json"
    if state.exists():
        try:
            return json.loads(state.read_text(encoding="utf-8")).get("aspect") or "9:16"
        except (json.JSONDecodeError, OSError):
            return "9:16"
    return "9:16"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", help="one story folder name")
    ap.add_argument("--force", action="store_true", help="redo even if already subtitled")
    a = ap.parse_args()

    stories = [STORIES / a.only] if a.only else sorted(
        d for d in STORIES.iterdir() if d.is_dir() and not d.name.startswith("_"))

    started, done, skipped, failed = time.time(), 0, 0, []
    for story_dir in stories:
        for kind in ("full", "short"):
            video = story_dir / f"final-en-{kind}.mp4"
            if not video.exists():
                continue
            if already_subtitled(video) and not a.force:
                skipped += 1
                continue
            segments = segments_for(story_dir, kind)
            if not segments:
                print(f"  {story_dir.name[:32]:32} en/{kind:5} no cut plan on disk, skipped")
                skipped += 1
                continue
            try:
                srt = video.with_suffix(".srt")
                count = subtitles.write_srt(segments, srt)
                width, height = resolution(aspect_of(story_dir), MEGAPIXELS)
                staged = video.with_name(video.stem + ".subbing.mp4")
                subtitles.burn(video, srt, staged, run_cmd, width, height)
                staged.replace(video)
                print(f"  {story_dir.name[:32]:32} en/{kind:5} {count:2} captions burned in")
                done += 1
            except Exception as exc:                                    # noqa: BLE001
                print(f"  {story_dir.name[:32]:32} en/{kind:5} FAILED "
                      f"{type(exc).__name__}: {str(exc)[:120]}")
                failed.append(f"{story_dir.name} en/{kind}")

    print()
    print(f"subtitled {done} film(s), skipped {skipped}, "
          f"in {(time.time() - started) / 60:.1f} min")
    for line in failed:
        print(f"  did not work -- {line}")


if __name__ == "__main__":
    main()
