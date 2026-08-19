"""Kathalu Studio -- split the story into shots and write the Telugu narration.

The model is given a narrow job: for each scene, say which library characters are in it,
write the visual action using only <Subject N> labels, and write the Telugu a narrator
would read over it. It does NOT write the H3 skeleton -- lib/h3_prompt.py assembles that
from the library records so identity blocks are byte-identical in every shot.

Scene length is governed by the narration, not the reverse. Phase 0 measured IndicF5 at
12.27 Telugu chars/sec with only +-1.3% spread across lines, which makes a character budget
a reliable proxy for seconds: ~124 chars fills the default 243-frame shot and 184 chars is
the ceiling at 362 frames. Actual durations get measured from the synthesised wav later and
the frame counts snapped then; this budget just keeps the writer in range.

Usage:
  OPENAI_API_KEY=... python write_script.py --story story3.json --cast cast3.json \\
      --out script3.json
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "cast"))

from story_cleanup import MODEL, call_openai  # noqa: E402
from source_text import (  # noqa: E402
    as_printed, english_moral, english_story, english_title,
)
import h3_prompt  # noqa: E402

CHARS_PER_SEC = 12.27          # phase 0, measured
SOFT_CHARS = 124               # 243 frames / 10.125 s
HARD_CHARS = 184               # 362 frames / 15.08 s
MAX_SCENES = 12
MAX_SUBJECTS_PER_SHOT = 4      # separate refs at max fidelity; 9 is the node cap

INSTRUCTIONS = """You are the director of a short animated film made from a printed Indian
children's moral story, and the writer of its Telugu narration.

Split the story into scenes. Each scene becomes one continuous shot with no cuts, and one
sentence or two of narration read over it. Aim for %(soft)d Telugu characters of narration
per scene and never exceed %(hard)d, because the shot is cut to fit the voice and the video
model tops out near fifteen seconds. Use as many scenes as the story needs, up to %(max_scenes)d.
Cover the whole story in order and leave nothing out.

THE CAST
You are given the exact cast, each with a `key`. In every scene, list the `key` of each
character visibly present, at most %(max_subjects)d, in the order they should be referenced.
The first listed becomes <Subject 1> in that scene, the second <Subject 2>, and so on --
numbering restarts every scene, because each shot only carries its own characters.

WRITING THE ACTION
`action` is the visual description of the shot. Rules:
- Refer to every character ONLY as <Subject 1>, <Subject 2> ... matching your `characters`
  order for that scene. Never write a character's name, species-as-identity, or any real,
  mythological or historical name. This is not stylistic: a name makes the video model
  substitute its own idea of the character and ignore the supplied artwork.
- Describe the setting, what each subject does, and how the shot progresses over its few
  seconds. One continuous camera move at most; no scene cuts inside a shot.
- Keep both subjects fully inside the frame for the whole shot. Do not ask the camera to
  push in far enough to crop anybody.
- No speech and no mouth movement -- the story is carried by the narrator. Describe gesture,
  posture, gaze and reaction instead.
- Do not use quotation marks anywhere in `action`.

WRITING THE TELUGU
`telugu_narration` is what the narrator says over that shot.
- Clean Telugu in native script only. No Roman letters at all, not even for names: write
  names in Telugu script. No digits: write numbers as Telugu words.
- Plain spoken register a grandmother would use reading aloud to a child, not literary
  grandhika Telugu. Avoid English loanwords where an ordinary Telugu word exists.
- Narrate in third person past tense. Report dialogue rather than performing it, so the
  narration carries the story without needing lip movement on screen.
- Keep the printed story's meaning and its order. Do not add events or morals.

IF THE BOOK WAS NOT PRINTED IN ENGLISH
You may be given `story_as_printed` as well. `story_text` is then an English translation,
and the two are the same story. Use each for what it is good for:
- The ENGLISH is what you write `action` and `summary_for_her` from. The video model reads
  only English.
- The ORIGINAL is what you write `telugu_narration` from. When it is already Telugu, follow
  its actual sentences and vocabulary closely -- that is a real Telugu storybook's voice,
  and it is better than anything recovered from a translation. Condense to fit the
  character budget, keep the register, and do not translate English back into Telugu.

Also give each scene a `summary_for_her`: one short plain-English sentence describing what
happens, for a review screen read by someone non-technical.

THE MORAL
Every one of these stories ends on a lesson, and the film ends on a card showing it.
- If the printed story already carries a Moral, keep its meaning and wording; do not
  reinvent it. Put the English in `moral_english` and the Telugu in `telugu_moral`. If the
  moral was printed in Telugu, use its own words for `telugu_moral`.
- If the printed story has NO Moral -- some pages carry none -- compose one. It must follow
  from the events of this story only, in one short sentence a child would understand. No
  proverbs bolted on, nothing the story does not actually show.
- Set `moral_source` to "printed" or "composed" so the review screen can say which it is.
- The Telugu moral follows the same rules as the narration: native script only, no Roman
  letters, no digits, plain spoken register.

`soundscape` is the diegetic ambience of the shot; `music` is the non-diegetic score. Keep
both brief and unobtrusive -- the narration is the focus."""

SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "scenes": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "summary_for_her": {"type": "string"},
                    "characters": {"type": "array", "items": {"type": "string"},
                                   "description": "library keys, in reference order"},
                    "action": {"type": "string"},
                    "telugu_narration": {"type": "string"},
                    "soundscape": {"type": "string"},
                    "music": {"type": "string"},
                },
                "required": ["summary_for_her", "characters", "action",
                             "telugu_narration", "soundscape", "music"],
            },
        },
        "telugu_title": {"type": "string"},
        "telugu_moral": {"type": "string"},
        "moral_english": {"type": "string"},
        "moral_source": {"type": "string", "enum": ["printed", "composed"]},
    },
    "required": ["scenes", "telugu_title", "telugu_moral",
                 "moral_english", "moral_source"],
}


def write_script(story: dict, cast_records: list[dict]) -> dict:
    cast_brief = [{"key": r["characterKey"], "name": r["name"], "species": r["species"],
                   "gender": r["gender"], "role": r.get("role", ""),
                   "appearance": r["description"]} for r in cast_records]

    got = call_openai({
        "model": MODEL,
        "messages": [
            {"role": "system", "content": INSTRUCTIONS % {
                "soft": SOFT_CHARS, "hard": HARD_CHARS,
                "max_scenes": MAX_SCENES, "max_subjects": MAX_SUBJECTS_PER_SHOT}},
            {"role": "user", "content": json.dumps({
                "title": english_title(story),
                "moral": english_moral(story),
                "story_text": english_story(story),
                # Only present when the book was not English. The shots are written from the
                # English above; the narration is written from this.
                "story_as_printed": as_printed(story),
                "cast": cast_brief,
            }, ensure_ascii=False, indent=1)},
        ],
        "response_format": {"type": "json_schema", "json_schema": {
            "name": "script", "strict": True, "schema": SCHEMA}},
    })
    out = json.loads(got["choices"][0]["message"]["content"])
    out["scenes"] = out["scenes"][:MAX_SCENES]
    out["_meta"] = {"model": got.get("model", MODEL), "usage": got.get("usage", {})}
    return out


def assemble(script: dict, cast_records: list[dict], telling_mode: str = "silent") -> dict:
    """Attach the built H3 prompt and every validation result to each scene."""
    by_key = {r["characterKey"]: r for r in cast_records}
    scenes = []
    for i, scene in enumerate(script["scenes"], 1):
        keys = [k for k in scene["characters"] if k in by_key][:MAX_SUBJECTS_PER_SHOT]
        unknown = [k for k in scene["characters"] if k not in by_key]
        subjects = [by_key[k] for k in keys]

        problems = [f"unknown character key: {k}" for k in unknown]
        if not subjects:
            problems.append("scene has no known characters, so there is nothing to reference")

        prompt = h3_prompt.build_prompt(
            action=scene["action"], subjects=subjects,
            soundscape=scene["soundscape"], music=scene["music"],
            telling_mode=telling_mode,
        ) if subjects else ""
        if subjects:
            problems += h3_prompt.validate_prompt(prompt, subjects, telling_mode)
        problems += h3_prompt.validate_narration(
            scene["telugu_narration"], CHARS_PER_SEC, SOFT_CHARS, HARD_CHARS)

        chars = len(scene["telugu_narration"])
        est = chars / CHARS_PER_SEC
        scenes.append({
            "index": i,
            "summary_for_her": scene["summary_for_her"],
            "characters": keys,
            "subject_names": [by_key[k]["name"] for k in keys],
            "reference_images": [by_key[k]["filename"] for k in keys],
            "action": scene["action"],
            "telugu_narration": scene["telugu_narration"],
            "narration_chars": chars,
            "estimated_seconds": round(est, 2),
            "planned_frames": h3_prompt.frames_for(est + 0.6),   # a little air either side
            "soundscape": scene["soundscape"],
            "music": scene["music"],
            "telling_mode": telling_mode,
            "h3_prompt": prompt,
            "problems": problems,
        })

    total_s = sum(s["estimated_seconds"] for s in scenes)
    moral_te = (script.get("telugu_moral") or "").strip()
    moral_problems = h3_prompt.validate_narration(
        moral_te, CHARS_PER_SEC, SOFT_CHARS, HARD_CHARS) if moral_te else ["moral is empty"]
    return {
        "title": script.get("telugu_title", ""),
        "telugu_moral": moral_te,
        "moral_english": (script.get("moral_english") or "").strip(),
        "moral_source": script.get("moral_source", "composed"),
        "moral_problems": moral_problems,
        "telling_mode": telling_mode,
        "scenes": scenes,
        "scene_count": len(scenes),
        "estimated_narration_seconds": round(total_s, 1),
        "estimated_video_seconds": round(sum(h3_prompt.seconds_for(s["planned_frames"])
                                             for s in scenes), 1),
        "problem_count": sum(len(s["problems"]) for s in scenes),
        "_meta": script.get("_meta", {}),
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--story", required=True)
    ap.add_argument("--cast", required=True, help="cast json from character_extract")
    ap.add_argument("--out", required=True)
    ap.add_argument("--telling-mode", default="silent", choices=["silent", "dialogue"])
    a = ap.parse_args()

    from build_cast import character_key, load_library

    story = json.loads(Path(a.story).read_text(encoding="utf-8"))
    cast = json.loads(Path(a.cast).read_text(encoding="utf-8"))
    library = load_library()

    records, missing = [], []
    for character in cast["characters"]:
        key = character_key(character)
        (records if key in library else missing).append(library.get(key, key))
    if missing:
        raise SystemExit(f"not in the character library yet: {missing}\nrun build_cast.py first")

    script = write_script(story, records)
    result = assemble(script, records, a.telling_mode)
    out_path = Path(a.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")

    m = result["_meta"]
    print(f"model {m.get('model')}  tokens {m.get('usage', {}).get('prompt_tokens')}/"
          f"{m.get('usage', {}).get('completion_tokens')}")
    print(f"telugu title : {result['title']}")
    print(f"moral ({result['moral_source']}):")
    print(f"  en: {result['moral_english']}")
    print(f"  te: {result['telugu_moral']}")
    for problem in result["moral_problems"]:
        print(f"  !! moral: {problem}")
    print(f"{result['scene_count']} scenes, {result['estimated_narration_seconds']}s of "
          f"narration -> {result['estimated_video_seconds']}s of video\n")
    for s in result["scenes"]:
        flag = f"  {len(s['problems'])} PROBLEM(S)" if s["problems"] else ""
        print(f"  scene {s['index']:2d}  {s['narration_chars']:3d} ch "
              f"~{s['estimated_seconds']:5.2f}s  {s['planned_frames']:3d}f  "
              f"[{', '.join(s['subject_names']) or 'none'}]{flag}")
        print(f"           {s['summary_for_her']}")
        print(f"           {s['telugu_narration']}")
        for p in s["problems"]:
            print(f"           !! {p}")
    print(f"\ntotal problems: {result['problem_count']}")


if __name__ == "__main__":
    main()
