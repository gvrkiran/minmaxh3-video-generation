"""Apply a batch of her edits to a finished story, then rebuild the film.

Batched on purpose. Redoing one scene at a time meant she watched eight clips, found three
problems, and then sat through three separate ~5 minute waits with the interface locked
between them. Now she marks everything she wants changed, presses once, and the pipeline
does the lot in a single pass -- which is also cheaper, because H3 loads once instead of
three times.

Three kinds of edit, each invalidating only what it actually affects:

  note     she describes what is wrong -> the shot description is rewritten and re-rendered.
           The narration and its timing are untouched, so the audio is not re-synthesised.
  telugu   she corrects the words -> re-spoken, re-measured, and the shot re-rendered at
           whatever new length the voice needs.
  remove   the scene is dropped from the film entirely.

Nothing here re-does work it does not have to. The pipeline already skips anything whose
output exists, so deleting exactly the stale artefacts is the whole mechanism.

Usage:
  python apply_edits.py --story-dir <dir> --edits <json file> [--aspect 9:16]
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
for extra in (HERE, HERE.parent / "lib", HERE.parent / "llm", HERE.parent / "cast"):
    sys.path.insert(0, str(extra))

import h3_prompt  # noqa: E402
from story_cleanup import MODEL, call_openai  # noqa: E402

LIBRARY = Path(r"H:/KathaluStudio/characters")
CHARS_PER_SEC = 12.27
SOFT_CHARS, HARD_CHARS = 124, 184

REVISE_INSTRUCTIONS = """You are revising ONE shot of a short animated film made from an
Indian children's moral story, because the person making the film said what was wrong with it.

You get the shot's current visual description, the subjects present, and her complaint.
Rewrite the shot so her complaint is addressed.

RULES
- Rewrite, do not append. Any detail that contradicts her request must be removed, not left
  standing beside the new one. A description holding both instructions makes the video model
  try to satisfy both at once, and it produces nonsense.
- Refer to characters ONLY as <Subject 1>, <Subject 2>, ... exactly as the current
  description does, with the same numbering. Never write a character's name: a name makes the
  video model substitute its own idea of the character and ignore the supplied artwork.
- Change only what her note is about. Keep the scene's place in the story, its characters and
  its beat. You are fixing a shot, not rewriting the story.
- Keep every subject fully inside the frame for the whole shot, and nobody speaks or opens
  their mouth -- the narrator carries the story.
- Do not use quotation marks.

Say in `what_changed` what you altered, in one plain English sentence she will read."""

REVISE_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "action": {"type": "string"},
        "summary_for_her": {"type": "string"},
        "what_changed": {"type": "string"},
    },
    "required": ["action", "summary_for_her", "what_changed"],
}


def revise_action(scene: dict, note: str) -> dict:
    got = call_openai({
        "model": MODEL,
        "messages": [
            {"role": "system", "content": REVISE_INSTRUCTIONS},
            {"role": "user", "content": json.dumps({
                "current_action": scene["action"],
                "subjects_present": scene["subject_names"],
                "her_complaint": note,
            }, ensure_ascii=False, indent=1)},
        ],
        "response_format": {"type": "json_schema", "json_schema": {
            "name": "revision", "strict": True, "schema": REVISE_SCHEMA}},
    })
    return json.loads(got["choices"][0]["message"]["content"])


def subjects_for(scene: dict) -> list[dict]:
    return [json.loads((LIBRARY / f"{Path(f).stem}.json").read_text(encoding="utf-8"))
            for f in scene["reference_images"]]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--story-dir", required=True)
    ap.add_argument("--edits", required=True, help="json: {scenes:[...], moral:{...}}")
    ap.add_argument("--aspect", default="9:16")
    a = ap.parse_args()

    story_dir = Path(a.story_dir)
    script_path = story_dir / "script.json"
    script = json.loads(script_path.read_text(encoding="utf-8"))
    plan = json.loads(Path(a.edits).read_text(encoding="utf-8"))

    by_index = {s["index"]: s for s in script["scenes"]}
    state_path = story_dir / "state.json"
    state = json.loads(state_path.read_text(encoding="utf-8")) if state_path.exists() else {}
    stale: list[Path] = [story_dir / "final.mp4"]
    applied: list[str] = []
    removed: set[int] = set()

    for edit in plan.get("scenes", []):
        index = int(edit["index"])
        scene = by_index.get(index)
        if scene is None:
            print(f"  scene {index}: not in this story, skipped", flush=True)
            continue
        pad = f"{index:02d}"

        if edit.get("remove"):
            removed.add(index)
            applied.append(f"scene {index} removed")
            print(f"  scene {index}: removed from the film", flush=True)
            continue

        note = (edit.get("note") or "").strip()
        telugu = (edit.get("telugu") or "").strip()
        touched = False

        if telugu and telugu != scene["telugu_narration"].strip():
            problems = h3_prompt.validate_narration(
                telugu, CHARS_PER_SEC, SOFT_CHARS, HARD_CHARS)
            if problems:
                raise SystemExit(
                    f"scene {index}: the new narration will not work -- " + "; ".join(problems))
            scene["telugu_narration"] = telugu
            scene["narration_chars"] = len(telugu)
            # New words means a new recording, a new length, and therefore a new shot.
            stale += [story_dir / "narration" / f"scene_{pad}.wav"]
            applied.append(f"scene {index} narration reworded")
            print(f"  scene {index}: narration reworded ({len(telugu)} chars)", flush=True)
            touched = True

        if note:
            revision = revise_action(scene, note)
            prompt = h3_prompt.build_prompt(
                action=revision["action"], subjects=subjects_for(scene),
                soundscape=scene["soundscape"], music=scene["music"],
                telling_mode=scene["telling_mode"])
            problems = h3_prompt.validate_prompt(
                prompt, subjects_for(scene), scene["telling_mode"])
            if problems:
                # The same guard as the original script: never let a bad prompt reach the GPU.
                raise SystemExit(f"scene {index}: the revision failed its checks -- "
                                 + "; ".join(problems))
            scene["action"] = revision["action"]
            scene["summary_for_her"] = revision["summary_for_her"]
            scene["h3_prompt"] = prompt
            scene["revision_note"] = note
            scene["what_changed"] = revision["what_changed"]
            applied.append(f"scene {index}: {revision['what_changed']}")
            print(f"  scene {index}: {revision['what_changed']}", flush=True)
            touched = True

        if not touched:
            # No note and no new words: she just wants a different take.
            applied.append(f"scene {index} re-rolled")
            print(f"  scene {index}: re-rolling the picture", flush=True)

        stale += [story_dir / "shots" / f"scene_{pad}.mp4",
                  story_dir / "narrated" / f"scene_{pad}.mp4"]
        entry = state.setdefault("scenes", {}).setdefault(str(index), {})
        # A different seed. Without this a re-roll would reproduce the identical shot.
        entry["redo_count"] = int(entry.get("redo_count", 0)) + 1
        entry.pop("video", None)
        entry.pop("narrated", None)

    moral = plan.get("moral") or {}
    new_moral_te = (moral.get("telugu") or "").strip()
    if new_moral_te and new_moral_te != (script.get("telugu_moral") or "").strip():
        problems = h3_prompt.validate_narration(
            new_moral_te, CHARS_PER_SEC, SOFT_CHARS, HARD_CHARS)
        if problems:
            raise SystemExit("the new moral will not work -- " + "; ".join(problems))
        script["telugu_moral"] = new_moral_te
        script["moral_source"] = "edited"
        if moral.get("english") is not None:
            script["moral_english"] = moral["english"].strip()
        stale += [story_dir / "narration" / "moral.wav",
                  story_dir / "narrated" / "zz_moral.mp4",
                  story_dir / "narrated" / "zz_moral.png"]
        applied.append("the lesson was reworded")
        print("  moral: reworded", flush=True)

    if removed:
        kept = [s for s in script["scenes"] if s["index"] not in removed]
        if not kept:
            raise SystemExit("that would remove every scene; at least one has to stay")
        script["scenes"] = kept

    if not applied:
        print("nothing to change", flush=True)
        raise SystemExit(0)

    script_path.write_text(json.dumps(script, ensure_ascii=False, indent=2), encoding="utf-8")
    state.pop("final", None)
    state_path.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")

    for path in stale:
        if path.exists():
            path.unlink()
            print(f"  cleared {path.name}", flush=True)

    (story_dir / "last-edit.json").write_text(
        json.dumps({"applied": applied}, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"\n{len(applied)} change(s); rebuilding. Everything untouched stays cached.",
          flush=True)
    done = subprocess.run(
        [sys.executable, "-u", str(HERE / "pipeline.py"),
         "--story-dir", str(story_dir), "--aspect", a.aspect],
        cwd=str(HERE))
    raise SystemExit(done.returncode)


if __name__ == "__main__":
    main()
