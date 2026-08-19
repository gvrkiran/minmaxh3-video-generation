"""Kathalu Studio -- work out who is in the story, and what the book's art looks like.

One call does both, because both need the same inputs: the cleaned story text and the
page photographs. It returns

  * a style paragraph describing THIS book's illustration style, derived from her actual
    pages. It is prepended verbatim to every character prompt so the whole cast matches
    each other and matches the book.
  * one entry per character that actually acts, with a self-contained visual description.

Two constraints come from downstream and are enforced here rather than discovered later:

  * H3 must never see a real character name -- famous, mythological or historical names
    make it substitute its own idea of the character and ignore the reference image. So
    `name` is UI-and-narration metadata only, and `appearance` must stand alone without
    it. See h3-r2v-prompt-rules.
  * Half the cast in this material is animals (a fox, a stork, a goat), so nothing may
    assume a human face.

Usage:
  OPENAI_API_KEY=... python character_extract.py --story story3.json \\
      --pages story3_1.jpeg --out cast3.json
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from story_cleanup import MODEL, call_openai, data_url

MAX_CAST = 6

INSTRUCTIONS = """You are the casting director and art director for a short animated film made
from a printed Indian children's moral story.

You get the cleaned story text and photographs of the original printed pages.

FIRST, the style paragraph.
Look at the illustrations in the photographs and describe that specific style in one dense
paragraph: rendering technique, line and shading treatment, colour palette and saturation,
proportions, how eyes and faces are drawn, lighting. Write it as instructions to an
illustrator who must match it, not as art criticism. This paragraph is prepended to every
character portrait prompt, so it must be concrete and repeatable. Do not mention any
individual character in it, and do not name real artists or studios.

SECOND, the cast.
List only characters who actually appear and act, at most %(max_cast)d, most important first.
Merge interchangeable groups into one entry ("three thieves" -> one thief, count 3) since
they share a design. Skip characters who are only mentioned.

For each one:
- `name`: what she would call them ("The priest", "Vishnu Sharma", "The fox").
- `kind`: "human" or "animal".
- `species`: "human", "fox", "stork", "goat", "lion", "donkey", "jackal", ...
- `gender`: "male", "female" or "unknown" -- for choosing a narration voice later.
- `role`: one short phrase on what they do in the story.
- `count`: how many identical individuals this entry covers, usually 1.
- `appearance`: the important field. A concrete, self-contained visual description for
  drawing this character: body type, face or muzzle, fur/skin/plumage colours, hair,
  clothing and its colours, and any prop they carry through the story. Base it on the
  illustrations when the character is visible in them; otherwise infer sensibly from the
  text and the period. It must read correctly with the name stripped out, so write "an
  elderly bald priest in a saffron dhoti", never "Vishnu Sharma's robes". Do not include
  the character's name, and do not name any real, mythological or historical figure.
- `portrait_pose`: a neutral standing or four-legged pose for a character reference sheet,
  facing slightly to one side, whole body visible, nothing occluding it.
- `proper_names`: every PROPER NAME this character is known by in the story -- personal
  names, and the names of real, mythological or historical figures. For "Vishnu Sharma"
  that is ["Vishnu", "Sharma"]. Leave it EMPTY for a purely descriptive name: "The fox",
  "The priest", "The village youths" contain no proper names at all. This list is what a
  later check uses to keep names out of the video prompt, so a common noun listed here
  would wrongly block the story, and a missed personal name would let the video model
  substitute its own idea of that figure.

Never put a name inside `appearance` or `portrait_pose`."""

SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "style_paragraph": {"type": "string"},
        "palette": {
            "type": "array",
            "description": "4-6 dominant colours of the book's art, as plain names.",
            "items": {"type": "string"},
        },
        "characters": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "name": {"type": "string"},
                    "kind": {"type": "string", "enum": ["human", "animal"]},
                    "species": {"type": "string"},
                    "gender": {"type": "string", "enum": ["male", "female", "unknown"]},
                    "role": {"type": "string"},
                    "count": {"type": "integer"},
                    "appearance": {"type": "string"},
                    "portrait_pose": {"type": "string"},
                    "proper_names": {
                        "type": "array",
                        "description": "Personal or historical names only; empty for a "
                                       "descriptive name.",
                        "items": {"type": "string"},
                    },
                },
                "required": ["name", "kind", "species", "gender", "role", "count",
                             "appearance", "portrait_pose", "proper_names"],
            },
        },
    },
    "required": ["style_paragraph", "palette", "characters"],
}

NAME_TOKEN_MIN = 4


def leaked_names(cast: list[dict]) -> list[str]:
    """Guard the one rule H3 cares about: no real names in the visual fields.

    Uses the names the model itself declared, rather than guessing which words of a display
    name are a name -- guessing flagged "village" in "The village youths" and blocked a
    whole story.
    """
    problems = []
    for c in cast:
        distinctive = [w for w in (str(n).strip() for n in c.get("proper_names") or [])
                       if len(w) >= NAME_TOKEN_MIN]
        for field in ("appearance", "portrait_pose"):
            low = c[field].lower()
            for tok in distinctive:
                if tok.lower() in low:
                    problems.append(f"{c['name']}: '{tok}' appears in {field}")
    return problems


def extract(story: dict, page_paths: list[Path]) -> dict:
    content: list[dict] = [{
        "type": "text",
        "text": json.dumps({
            "title": story.get("title", ""),
            "moral": story.get("moral", ""),
            "story_text": story.get("story_text", ""),
        }, ensure_ascii=False, indent=1),
    }]
    for path in page_paths:
        content.append({"type": "text", "text": f"--- printed page: {path.name} ---"})
        content.append({"type": "image_url",
                        "image_url": {"url": data_url(path), "detail": "high"}})

    got = call_openai({
        "model": MODEL,
        "messages": [
            {"role": "system", "content": INSTRUCTIONS % {"max_cast": MAX_CAST}},
            {"role": "user", "content": content},
        ],
        "response_format": {
            "type": "json_schema",
            "json_schema": {"name": "cast", "strict": True, "schema": SCHEMA},
        },
    })
    out = json.loads(got["choices"][0]["message"]["content"])
    out["characters"] = out["characters"][:MAX_CAST]
    out["_meta"] = {"model": got.get("model", MODEL), "usage": got.get("usage", {})}
    out["_name_leaks"] = leaked_names(out["characters"])
    return out


REVISE_INSTRUCTIONS = """You maintain character designs for an illustrated children's story.

Given a character's current visual description and a change requested by the person using
the tool, rewrite the description so it incorporates the change coherently.

Rewrite, do not append. Every detail that contradicts the requested change must be removed
or altered, not left standing beside it -- a description that says both "brown and white
patches" and "pure white" makes the illustrator draw two animals. Keep everything the
change does not touch exactly as it was, so the character stays recognisably itself.

Keep the same voice and level of concrete detail. Do not include the character's name. Do
not add a second character, a background, or a prop that was not requested."""

REVISE_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "appearance": {"type": "string", "description": "The rewritten description."},
        "changed": {"type": "string", "description": "One line on what you altered."},
    },
    "required": ["appearance", "changed"],
}


def revise_appearance(appearance: str, note: str) -> dict:
    """Merge a free-text tweak INTO the description rather than tacking it on the end."""
    got = call_openai({
        "model": MODEL,
        "messages": [
            {"role": "system", "content": REVISE_INSTRUCTIONS},
            {"role": "user", "content": json.dumps(
                {"current_description": appearance, "requested_change": note},
                ensure_ascii=False, indent=1)},
        ],
        "response_format": {"type": "json_schema", "json_schema": {
            "name": "revision", "strict": True, "schema": REVISE_SCHEMA}},
    })
    return json.loads(got["choices"][0]["message"]["content"])


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--story", required=True)
    ap.add_argument("--pages", nargs="+", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    story = json.loads(Path(a.story).read_text(encoding="utf-8"))
    result = extract(story, [Path(p) for p in a.pages])
    out_path = Path(a.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"title: {story.get('title')}")
    print(f"palette: {', '.join(result['palette'])}")
    print(f"\nstyle paragraph ({len(result['style_paragraph'])} chars):")
    print("  " + result["style_paragraph"])
    print(f"\ncast of {len(result['characters'])}:")
    for c in result["characters"]:
        tag = f"x{c['count']}" if c["count"] > 1 else "  "
        print(f"  {c['name']:<22s} {tag} {c['kind']:6s} {c['species']:<8s} {c['gender']:<7s} {c['role']}")
        print(f"      {c['appearance']}")
    if result["_name_leaks"]:
        print("\nNAME LEAKS (would break H3 reference fidelity):")
        for p in result["_name_leaks"]:
            print(f"  - {p}")
    else:
        print("\nname check: clean (no real names in visual fields)")


if __name__ == "__main__":
    main()
