"""Redo one scene from her note, and rebuild the film around it.

The trick is that nothing new is needed to re-render: the pipeline already skips work whose
output exists, so redoing a scene is "revise it, delete only that scene's artefacts, run the
pipeline again". Everything else stays cached and the join picks up the new shot.

Her note is applied by rewriting the scene rather than appending to it. Appending was already
shown to fail on character portraits -- "make the goat pure white" left beside "brown-and-white
patches" produced two goats, because the model satisfied both descriptions. The same trap
applies to a shot description, so the revision is a rewrite.

Usage:
  python regen_scene.py --story-dir <dir> --index 3 --note "the fox should look sly, not scared"
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "lib"))
sys.path.insert(0, str(HERE.parent / "llm"))
sys.path.insert(0, str(HERE.parent / "cast"))

import h3_prompt  # noqa: E402
from story_cleanup import MODEL, call_openai  # noqa: E402

CHARS_PER_SEC = 12.27
SOFT_CHARS, HARD_CHARS = 124, 184

INSTRUCTIONS = """You are revising ONE shot of a short animated film made from an Indian
children's moral story, because the person making the film said what was wrong with it.

You get the shot's current visual description, its Telugu narration, the subjects present,
and her complaint. Rewrite the shot so her complaint is addressed.

RULES
- Rewrite, do not append. Any detail that contradicts her request must be removed, not left
  standing beside the new one. A description holding both the old and the new instruction
  makes the video model try to satisfy both at once.
- Refer to characters ONLY as <Subject 1>, <Subject 2>, ... exactly as the current
  description does, and keep the same numbering. Never write a character's name: a name
  makes the video model substitute its own idea of the character and ignore the supplied
  artwork.
- Change only what her note is about. Keep the scene's place in the story, the same
  characters, and the same beat. You are fixing a shot, not rewriting the story.
- Keep both subjects fully inside the frame for the whole shot, and no character speaks or
  opens its mouth -- the narrator carries the story.
- Do not use quotation marks.

THE NARRATION
Change `telugu_narration` only if her note is about the words or the telling. If it is about
the picture, return the existing narration unchanged -- rewriting it would re-synthesise the
voice and change the shot's length for no reason.
If you do change it: clean Telugu in native script only, no Roman letters, no digits, plain
spoken register, and at most %(hard)d characters.

Say in `what_changed` what you altered, in one plain English sentence she will read."""

SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "action": {"type": "string"},
        "telugu_narration": {"type": "string"},
        "narration_changed": {"type": "boolean"},
        "summary_for_her": {"type": "string"},
        "what_changed": {"type": "string"},
    },
    "required": ["action", "telugu_narration", "narration_changed",
                 "summary_for_her", "what_changed"],
}


def revise(scene: dict, note: str) -> dict:
    got = call_openai({
        "model": MODEL,
        "messages": [
            {"role": "system", "content": INSTRUCTIONS % {"hard": HARD_CHARS}},
            {"role": "user", "content": json.dumps({
                "current_action": scene["action"],
                "current_telugu_narration": scene["telugu_narration"],
                "subjects_present": scene["subject_names"],
                "her_complaint": note,
            }, ensure_ascii=False, indent=1)},
        ],
        "response_format": {"type": "json_schema", "json_schema": {
            "name": "revision", "strict": True, "schema": SCHEMA}},
    })
    return json.loads(got["choices"][0]["message"]["content"])


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--story-dir", required=True)
    ap.add_argument("--index", type=int, required=True)
    ap.add_argument("--note", default="")
    ap.add_argument("--aspect", default="9:16")
    a = ap.parse_args()

    story_dir = Path(a.story_dir)
    script_path = story_dir / "script.json"
    script = json.loads(script_path.read_text(encoding="utf-8"))
    scene = next((s for s in script["scenes"] if s["index"] == a.index), None)
    if scene is None:
        raise SystemExit(f"no scene {a.index} in this story")

    pad = f"{a.index:02d}"
    narration_changed = False

    if a.note.strip():
        print(f"revising scene {a.index} from her note...", flush=True)
        revision = revise(scene, a.note.strip())
        print(f"  {revision['what_changed']}", flush=True)

        subjects = [json.loads((Path(r"H:/KathaluStudio/characters") / f"{Path(f).stem}.json")
                               .read_text(encoding="utf-8"))
                    for f in scene["reference_images"]]
        prompt = h3_prompt.build_prompt(
            action=revision["action"], subjects=subjects,
            soundscape=scene["soundscape"], music=scene["music"],
            telling_mode=scene["telling_mode"])

        problems = h3_prompt.validate_prompt(prompt, subjects, scene["telling_mode"])
        new_narration = revision["telugu_narration"].strip()
        narration_changed = bool(revision["narration_changed"]) and \
            new_narration != scene["telugu_narration"].strip()
        if narration_changed:
            problems += h3_prompt.validate_narration(
                new_narration, CHARS_PER_SEC, SOFT_CHARS, HARD_CHARS)
        if problems:
            # Same guard as the original script: never let a bad prompt reach the GPU.
            raise SystemExit("the revision failed its checks:\n  " + "\n  ".join(problems))

        scene["action"] = revision["action"]
        scene["summary_for_her"] = revision["summary_for_her"]
        scene["h3_prompt"] = prompt
        scene["revision_note"] = a.note.strip()
        scene["what_changed"] = revision["what_changed"]
        if narration_changed:
            scene["telugu_narration"] = new_narration
            scene["narration_chars"] = len(new_narration)
        script_path.write_text(json.dumps(script, ensure_ascii=False, indent=2), encoding="utf-8")
        print("  script.json updated", flush=True)
    else:
        print(f"scene {a.index}: no note, so just re-rolling the picture", flush=True)

    # Invalidate only this scene, plus the things derived from the whole set.
    stale = [story_dir / "shots" / f"scene_{pad}.mp4",
             story_dir / "narrated" / f"scene_{pad}.mp4",
             story_dir / "final.mp4"]
    if narration_changed:
        stale.append(story_dir / "narration" / f"scene_{pad}.wav")
    for path in stale:
        if path.exists():
            path.unlink()
            print(f"  cleared {path.name}", flush=True)

    # A different seed, or a re-roll with no note would reproduce the same shot exactly.
    state_path = story_dir / "state.json"
    if state_path.exists():
        state = json.loads(state_path.read_text(encoding="utf-8"))
        entry = state.setdefault("scenes", {}).setdefault(str(a.index), {})
        entry["redo_count"] = int(entry.get("redo_count", 0)) + 1
        entry.pop("video", None)
        entry.pop("narrated", None)
        state.pop("final", None)
        state_path.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"re-running the pipeline; everything else is cached", flush=True)
    done = subprocess.run(
        [sys.executable, "-u", str(HERE / "pipeline.py"),
         "--story-dir", str(story_dir), "--aspect", a.aspect],
        cwd=str(HERE))
    raise SystemExit(done.returncode)


if __name__ == "__main__":
    main()
