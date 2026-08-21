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

# The gate is decided by COUNTING, not by asking the model how well it did.
#
# It used to gate on `fraction_legible`, the model's own estimate, and that estimate is far
# too noisy to make a decision with. Her real story page -- the one that went through this
# morning and produced a good Telugu story -- scored 0.82 on the run that accepted it and
# 0.62 on four consecutive runs afterwards, against a 0.75 threshold. So the same photograph
# accepted or refused depending on the hour. A page that worked yesterday must not be refused
# today.
#
# What is stable is what came back: how much real text, against how many spans it marked
# unreadable. Measured across the pages we know the answer for:
#
#   the-old-bull  (good)  1,321 real chars,  2 gaps  -> recovered 0.96
#   bad-company   (good)  1,684 real chars,  3 gaps  -> recovered 0.96
#   story 8 p1    (bad)      26 real chars, many     -> recovered 0.09
#
# That is a ten-fold separation from a countable quantity, against 0.62-vs-0.82 from a
# judgement. Decide on the count; keep the estimate on the record as a note.
CHARS_PER_GAP = 25          # what one [UNREADABLE] marker stands in for, roughly a phrase
MIN_RECOVERED = 0.60        # share of the page that came back as real text
MIN_REAL_CHARS = 200        # a story page always carries more than this; a title page may not

# Retained only to report, and for older records. Not a gate any more.
MIN_LEGIBLE = 0.75

# Transcribing is copying, not thinking, and on this task more reasoning makes the model
# WORSE as well as dearer. Measured on the same unreadable page: at low effort it produced
# 26 characters and rated the page 0.02 legible; at medium it produced 1,195 characters and
# rated it 0.55. Given room to reason it reasons its way to what the text must have said,
# which is the exact failure this stage exists to catch. Low effort is eight times cheaper
# than the default AND separates the good page from the bad one far more sharply
# (0.02 vs 0.82, against 0.55 vs 0.88 at medium).
EFFORT = "low"

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


def photo_size(path: Path) -> list[int] | None:
    """Pixel dimensions, for the message she gets when a photo is too hard to read.

    Deliberately NOT used as a gate. Total pixels do not predict legibility: her Telugu page
    that reads perfectly is 0.52 MP, and the four screenshots that read as nothing are 0.59
    MP -- larger. What matters is pixels per character, which depends on how much of the
    frame the text fills and how dense the page is, and there is no way to know that without
    reading it. So this is for telling her the size, not for judging it.
    """
    try:
        from PIL import Image
        with Image.open(path) as im:
            return [im.size[0], im.size[1]]
    except Exception:
        return None


class PageTooHard(Exception):
    """The photographs cannot be read well enough to build a story from them."""

    def __init__(self, message: str, detail: dict):
        super().__init__(message)
        self.detail = detail


def transcribe_page(path: Path, page_no: int, total: int) -> dict:
    """One page, read as literally as the model can manage."""
    hint = {"page": path.name, "photo_size_pixels": photo_size(path)}
    got = call_openai({
        "model": MODEL,
        "reasoning_effort": EFFORT,
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
    # Kept because reading pages is now the largest per-story API cost, and the only way to
    # judge a cheaper model for this stage is to have the real token counts for this one.
    out["usage"] = got.get("usage", {})
    return out


def transcribe(page_paths: list[Path]) -> dict:
    """Transcribe every page, and refuse if too little of the story is legible."""
    started = time.time()
    pages = [transcribe_page(p, i, len(page_paths))
             for i, p in enumerate(page_paths, 1)]

    # Weight by how much text each page holds, so one short legible page cannot carry three
    # unreadable ones. Reported, not decided on.
    weights = [max(1, len(p["text"])) for p in pages]
    legible = sum(p["fraction_legible"] * w for p, w in zip(pages, weights)) / sum(weights)

    # The model's own fraction_legible is a judgement and it is noisy -- the same page came
    # back 0.88 and 0.98 on two identical calls. So record a countable signal next to it:
    # how much real text came out per unreadable marker. Nothing depends on this yet, but a
    # later cross-check needs a number that is not the model grading its own homework.
    for pg in pages:
        gaps = pg.get("unreadable_spans") or 0
        real = len(pg.get("text", "").replace(GAP, "").strip())
        pg["real_chars"] = real
        pg["chars_per_gap"] = round(real / gaps, 1) if gaps else None

    # Decided across the whole story, not per page: a story can legitimately include a title
    # page carrying almost no text, and that must not sink the pages that do carry it.
    total_real = sum(pg["real_chars"] for pg in pages)
    total_gaps = sum(pg.get("unreadable_spans") or 0 for pg in pages)
    recovered = total_real / (total_real + total_gaps * CHARS_PER_GAP) if total_real else 0.0

    worst = min(pages, key=lambda p: p["real_chars"])
    result = {
        "pages": pages,
        "language": next((p["language"] for p in pages if p.get("language")), ""),
        "title": next((p["title"] for p in pages if p.get("title")), ""),
        "recovered": round(recovered, 3),
        "real_chars": total_real,
        "unreadable_spans": total_gaps,
        "fraction_legible": round(legible, 3),
        "columns": max((p.get("column_count") or 1) for p in pages),
        "seconds": round(time.time() - started, 1),
        "usage": {
            "prompt_tokens": sum(p.get("usage", {}).get("prompt_tokens", 0) for p in pages),
            "completion_tokens": sum(p.get("usage", {}).get("completion_tokens", 0)
                                     for p in pages),
        },
    }

    if recovered < MIN_RECOVERED or total_real < MIN_REAL_CHARS:
        problems = [p["problem"].strip() for p in pages if p.get("problem", "").strip()]
        raise PageTooHard(
            "These photographs cannot be read well enough to make a story from them.",
            {
                "readable_fraction": round(recovered, 2),
                "real_chars": total_real,
                "unreadable_spans": total_gaps,
                "model_estimate": round(legible, 2),
                "pages_too_hard": [p["page"] for p in pages
                                   if p["real_chars"] < MIN_REAL_CHARS],
                "what_is_wrong": problems[0] if problems else
                                 "The printed words are too small to resolve.",
                "all_problems": problems,
                "photo_sizes": {p.name: photo_size(p) for p in page_paths},
                "columns": result["columns"],
                "language": result["language"],
                "worst_page": worst["page"],
            },
        )
    return result
