"""Read what is actually on the page, and refuse when the page cannot be read.

This exists because of story 8. Four photographs of a Telugu book went in, and a complete,
fluent, entirely different story came out -- the Panchatantra tale of Viravara and King
Shudraka, which the model knew by heart. It reported photo_complete: true, zero
reconstructions, and an empty note. Nothing anywhere said it had invented the whole thing.

Measured afterwards, the cause was not subtle: the best reader available could make out 22%
of that page. The photographs were 576x1024 screenshots of a two-column page shot at an
angle, giving 8.3 pixels per Telugu character where 20-25 are needed -- Telugu stacks vowel
signs and conjuncts above and below the base glyph, and at a 10px line height those marks
are one or two pixels. The text was not recoverable by anything.

Faced with a page it could not read and a licence to reconstruct, the model reached for the
nearest story it knew. That is the predictable outcome, and the fix is not a better prompt
for the reconstruction -- it is to find out how much is legible BEFORE deciding whether
there is anything to reconstruct, and to stop when the answer is "not enough".

So this stage transcribes only what is visibly printed, marks every gap it cannot read, and
reports the fraction it managed. The caller refuses below MIN_LEGIBLE. Refusing costs her
one retaken photograph. Not refusing costs her a video of the wrong story, and she has no
way to tell.
"""
from __future__ import annotations

import json
import time
from pathlib import Path

from story_cleanup import MODEL, call_openai, data_url

# Below this, do not attempt a story. Chosen from measurement rather than taste: the Telugu
# page that came out as a different story sat at 0.22, and the single-column page that came
# through correctly sat near 1.0. Anything under three-quarters legible means the gaps are
# large enough to be filled with invention rather than with the sentence's own obvious ending.
MIN_LEGIBLE = 0.75

GAP = "[UNREADABLE]"

INSTRUCTIONS = """Transcribe the text printed on each page image, exactly as printed.

TRANSCRIBE, DO NOT COMPOSE. This is the whole job. You are not writing a story, and you are
not finishing one. You are copying out words that are visibly present in a photograph.
- Never write a word that is not legibly on the page in front of you.
- Never continue a sentence, a paragraph or a story from your own knowledge. You may well
  recognise the tale -- many of these are Panchatantra or Jataka stories you know well. That
  recognition is a trap here. A remembered story is not this page, and a remembered version
  has different names, different villages and a different ending.
- Where you cannot read something, write the marker %(gap)s and move on. A page full of
  %(gap)s markers is a correct and useful answer. An invented page is not.

LAYOUT
Say how the page is laid out. Many of these books set the body text in TWO COLUMNS. When
they do, read the entire left column top to bottom, then the entire right column -- never
alternate between them, or the sentences will interleave into nonsense.

WHAT COUNTS AS UNREADABLE
Mark %(gap)s for text that is cut off by the edge of the photograph, hidden in the gutter
or a shadow, too blurred to resolve, or too small to be certain of. For an Indian script, be
strict: if you cannot resolve the vowel signs and conjuncts above and below the base letters,
you cannot read the word, however confident you feel about the shape of it. Guessing at a
name gives her a video about somebody who does not exist in her book.

REPORT HONESTLY
- `fraction_legible`: your own estimate, 0.0 to 1.0, of how much of this page's printed body
  text you actually read. Judge it as a proportion of the text you can see is there,
  including text you could see was present but could not resolve.
- `unreadable_spans`: how many %(gap)s markers you used.
- `language`: the language the page is printed in.
- `problem`: if the photograph itself is the problem, say so in one plain sentence -- too
  small, out of focus, taken at an angle, page edge cut off, glare across the text. This is
  read by someone non-technical who will retake the photograph, so describe what to fix, not
  what is wrong in the abstract. Leave it empty if the photograph is fine."""

SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "title": {"type": "string", "description": "The printed title, or empty."},
        "language": {"type": "string"},
        "column_count": {"type": "integer", "description": "1 for single column, 2 for two."},
        "text": {
            "type": "string",
            "description": "The page transcribed in correct reading order -- for two "
                           "columns, the whole left column then the whole right column. "
                           "Use the unreadable marker for anything you could not read.",
        },
        "fraction_legible": {"type": "number"},
        "unreadable_spans": {"type": "integer"},
        "problem": {"type": "string"},
    },
    "required": ["title", "language", "column_count", "text",
                 "fraction_legible", "unreadable_spans", "problem"],
}


class PageTooHard(Exception):
    """The photographs cannot be read well enough to build a story from them."""

    def __init__(self, message: str, detail: dict):
        super().__init__(message)
        self.detail = detail


def transcribe_page(path: Path, ocr: dict, page_no: int, total: int) -> dict:
    """One page, read as literally as the model can manage."""
    hint = {
        "page": path.name,
        # Said plainly, because the transcript below is actively misleading otherwise. The
        # engine is a Chinese/English model with no Indic characters in its vocabulary at
        # all: on a Telugu page it returns Latin letters that merely resemble the glyph
        # shapes, and it interleaves the columns of a two-column page.
        "ocr_engine_note": "The OCR engine can only read Latin and Chinese script, and it "
                           "cannot represent any Indian script. If this page is printed in "
                           "an Indian script, its transcript below is meaningless noise -- "
                           "ignore it completely and read the image yourself. It also "
                           "interleaves columns, so its line order is unreliable.",
        "ocr_transcript": ocr.get("raw_text", ""),
        "ocr_mean_confidence": ocr.get("mean_confidence"),
        "sides_where_lines_reach_the_photo_edge": ocr.get("suspect_sides") or [],
        "photo_size_pixels": ocr.get("photo_size"),
    }
    got = call_openai({
        "model": MODEL,
        "messages": [
            {"role": "system", "content": INSTRUCTIONS % {"gap": GAP}},
            {"role": "user", "content": [
                {"type": "text",
                 "text": f"--- PAGE {page_no} of {total} ---\n"
                         + json.dumps(hint, ensure_ascii=False, indent=1)},
                {"type": "image_url",
                 "image_url": {"url": data_url(path), "detail": "high"}},
            ]},
        ],
        "response_format": {"type": "json_schema", "json_schema": {
            "name": "page_transcript", "strict": True, "schema": SCHEMA}},
    })
    out = json.loads(got["choices"][0]["message"]["content"])
    out["page"] = path.name
    return out


def transcribe(page_paths: list[Path], ocr: dict) -> dict:
    """Transcribe every page, and refuse if too little of the story is legible."""
    by_file = {p["file"]: p for p in ocr.get("pages", [])}
    started = time.time()
    pages = [transcribe_page(p, by_file.get(p.name, {}), i, len(page_paths))
             for i, p in enumerate(page_paths, 1)]

    # Weight by how much text each page holds, so one short legible page cannot carry three
    # unreadable ones.
    weights = [max(1, len(p["text"])) for p in pages]
    legible = sum(p["fraction_legible"] * w for p, w in zip(pages, weights)) / sum(weights)

    worst = min(pages, key=lambda p: p["fraction_legible"])
    result = {
        "pages": pages,
        "language": next((p["language"] for p in pages if p.get("language")), ""),
        "title": next((p["title"] for p in pages if p.get("title")), ""),
        "fraction_legible": round(legible, 3),
        "columns": max((p.get("column_count") or 1) for p in pages),
        "seconds": round(time.time() - started, 1),
    }

    if legible < MIN_LEGIBLE:
        problems = [p["problem"].strip() for p in pages if p.get("problem", "").strip()]
        raise PageTooHard(
            "These photographs cannot be read well enough to make a story from them.",
            {
                "readable_fraction": round(legible, 2),
                "pages_too_hard": [p["page"] for p in pages
                                   if p["fraction_legible"] < MIN_LEGIBLE],
                "what_is_wrong": problems[0] if problems else
                                 "The printed words are too small to resolve.",
                "all_problems": problems,
                "photo_sizes": {p["file"]: p.get("photo_size")
                                for p in ocr.get("pages", [])},
                "columns": result["columns"],
                "language": result["language"],
                "worst_page": worst["page"],
            },
        )
    return result
