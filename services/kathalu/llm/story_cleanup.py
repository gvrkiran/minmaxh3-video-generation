"""Kathalu Studio -- turn OCR output plus the page photos into a complete story.

The local reader (page_reader.py) gets most of the text but not all: on curved pages a
few steeply-tilted lines go undetected, spacing and quote marks get mangled, and where
the photograph cut off a margin the printed words were never captured at all.

This step repairs all of that. It is told what kind of text it is looking at -- a short
Indian moral story for children -- and it is allowed to reconstruct short spans the
camera missed, so she is never stopped dead by a demand to re-photograph a page.

The safeguard is disclosure, not refusal. Every reconstructed span is recorded in
`reconstructions` with the words that surround it, so the review screen can show her
exactly what was filled in and let her correct it before anything is animated. Silent
invention is the thing to avoid; visible, checkable completion is useful.

Usage:
  OPENAI_API_KEY=... python story_cleanup.py --ocr ocr-result.json \\
      --pages story4_1.jpeg story4_2.jpeg --out story.json
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path

API = "https://api.openai.com/v1/chat/completions"
MODEL = os.environ.get("KATHALU_TEXT_MODEL", "gpt-5.5")

DEFAULT_CONTEXT = (
    "A short moral story for children from India -- the Panchatantra, Jataka and Indian "
    "Aesop retelling tradition. Typically one or two printed pages, a title at the top, "
    "simple past-tense narration, talking animals or a king, priest, merchant or teacher, "
    "a little dialogue in double quotes, and very often a short 'Moral' printed in a "
    "decorative roundel at the end."
)

INSTRUCTIONS = """You are reconstructing a printed children's story from photographs of book pages.

WHAT YOU ARE LOOKING AT
{context}

You are given, for each page in reading order: the photograph, and a noisy transcript
from a local OCR engine. The PHOTOGRAPH is the better source. The transcript is a hint
that saves you effort and contains errors.

Produce one clean, complete, readable story.

FIX THE OCR
- Restore words and whole lines the engine missed. It drops steeply tilted lines where
  the page curves, loses spaces ("scaringhim" -> "scaring him", "Getout" -> "Get out"),
  drops apostrophes and opening quotation marks, and confuses letters ("Rnigdo" ->
  "kingdom", "advl" -> "advisor", "Prinees" -> "Princes").
- Join lines into natural paragraphs. Keep the printed wording wherever you can read it:
  do not modernise, shorten, paraphrase or improve prose that is plainly visible.
- Drop page numbers and decorative marks. Keep the title out of the body.
- Put any "Moral" text in `moral`, on a single line. The roundel breaks it across three
  short lines; those breaks are layout, not punctuation.
- These are often two-page spreads, so the transcript may hold stray fragments from a
  partly visible facing page ("The ja", "or tig"). Those belong to another page. Leave
  them out, and if a later page in this set covers that content properly, all is well.

FILL WHAT THE CAMERA MISSED
Where a margin was cut off, the printed words are simply not in the photograph. Complete
them, so the story reads properly end to end. Rules for doing that honestly:
- Stay minimal. Complete the clipped words and finish the sentence; usually a few words
  is all that is missing. Most clipped endings are strongly implied by what IS readable,
  including later mentions on the same page -- "He ruled over a kingdo[cut] Mahilaropyam"
  is plainly "a kingdom called Mahilaropyam".
- Match the surrounding voice, tense and reading level exactly. It must not be obvious
  which words came from the page and which from you.
- Invent no new events, characters, dialogue or morals. You are closing gaps in a
  sentence, not writing a story.
- Record EVERY span you supplied in `reconstructions`, with the readable words on either
  side of it, so a person can check each one.
- If something much larger is absent -- a whole paragraph, or the end of the story --
  reconstruct it if the narrative clearly implies it, mark it as low confidence, and say
  so plainly in `note_for_her`.

The OCR hints flag sides where lines merely REACH the edge of the photograph. That is a
suspicion, not a fact: text can sit close to a margin and still be complete. Judge from
the image. If the words at that edge are whole, nothing was cut and nothing needs filling.

`note_for_her` is read by a non-technical person. If you filled anything in, tell her in
one or two plain sentences which page was cut off and that she should read those bits to
check them. If you filled in nothing, leave it empty. No jargon."""

SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "title": {"type": "string", "description": "The story's printed title."},
        "story_text": {
            "type": "string",
            "description": "The complete story, paragraphs separated by blank lines, with "
                           "any reconstructed spans woven in so it reads naturally. No "
                           "markers or brackets in this field.",
        },
        "moral": {"type": "string", "description": "The Moral, on one line, or empty."},
        "language": {"type": "string"},
        "photo_complete": {
            "type": "boolean",
            "description": "True if the photographs captured the whole story, so nothing "
                           "had to be reconstructed.",
        },
        "reconstructions": {
            "type": "array",
            "description": "One entry per span you supplied because the photo cut it off.",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "page": {"type": "string"},
                    "side": {"type": "string", "enum": ["left", "right", "top", "bottom"]},
                    "visible_before": {"type": "string",
                                       "description": "Readable words immediately before."},
                    "inserted": {"type": "string",
                                 "description": "Exactly the words you supplied."},
                    "visible_after": {"type": "string",
                                      "description": "Readable words immediately after."},
                    "basis": {"type": "string",
                              "description": "Why these words, from what visible evidence."},
                    "confidence": {"type": "string", "enum": ["high", "medium", "low"]},
                },
                "required": ["page", "side", "visible_before", "inserted",
                             "visible_after", "basis", "confidence"],
            },
        },
        "pages": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "page": {"type": "string"},
                    "was_cut_off": {"type": "boolean"},
                    "lines_recovered": {
                        "type": "integer",
                        "description": "Lines read from the image that OCR had missed.",
                    },
                },
                "required": ["page", "was_cut_off", "lines_recovered"],
            },
        },
        "note_for_her": {"type": "string"},
    },
    "required": ["title", "story_text", "moral", "language", "photo_complete",
                 "reconstructions", "pages", "note_for_her"],
}


def data_url(path: Path) -> str:
    return "data:image/jpeg;base64," + base64.b64encode(path.read_bytes()).decode()


def call_openai(payload: dict, retries: int = 3) -> dict:
    key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not key:
        raise SystemExit("OPENAI_API_KEY is not set.")
    body = json.dumps(payload).encode()
    last = ""
    for attempt in range(retries):
        req = urllib.request.Request(
            API, data=body,
            headers={"content-type": "application/json", "authorization": f"Bearer {key}"},
        )
        try:
            with urllib.request.urlopen(req, timeout=420) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            last = e.read().decode("utf-8", "replace")[:900]
            if e.code in (429, 500, 502, 503, 504) and attempt < retries - 1:
                time.sleep(4 * (attempt + 1))
                continue
            raise SystemExit(f"OpenAI HTTP {e.code}: {last}")
        except urllib.error.URLError as e:
            if attempt < retries - 1:
                time.sleep(4 * (attempt + 1))
                continue
            raise SystemExit(f"OpenAI unreachable: {e}")
    raise SystemExit(f"OpenAI failed: {last}")


def clean_story(page_paths: list[Path], ocr: dict, context: str = DEFAULT_CONTEXT) -> dict:
    by_file = {p["file"]: p for p in ocr.get("pages", [])}

    content: list[dict] = [{
        "type": "text",
        "text": f"This story spans {len(page_paths)} page(s), given in reading order.",
    }]
    for i, path in enumerate(page_paths, 1):
        rec = by_file.get(path.name, {})
        hint = {
            "page": path.name,
            "ocr_line_count": rec.get("line_count"),
            "ocr_mean_confidence": rec.get("mean_confidence"),
            "sides_where_lines_reach_the_photo_edge": rec.get("suspect_sides") or [],
            "ocr_transcript": rec.get("raw_text", ""),
        }
        content.append({"type": "text",
                        "text": f"--- PAGE {i} of {len(page_paths)} ---\n"
                                + json.dumps(hint, ensure_ascii=False, indent=1)})
        content.append({"type": "image_url",
                        "image_url": {"url": data_url(path), "detail": "high"}})

    started = time.time()
    got = call_openai({
        "model": MODEL,
        "messages": [
            {"role": "system", "content": INSTRUCTIONS.format(context=context)},
            {"role": "user", "content": content},
        ],
        "response_format": {
            "type": "json_schema",
            "json_schema": {"name": "story", "strict": True, "schema": SCHEMA},
        },
    })
    out = json.loads(got["choices"][0]["message"]["content"])
    out["_meta"] = {"model": got.get("model", MODEL),
                    "seconds": round(time.time() - started, 1),
                    "usage": got.get("usage", {})}
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ocr", required=True)
    ap.add_argument("--pages", nargs="+", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--context", default=DEFAULT_CONTEXT)
    a = ap.parse_args()

    ocr = json.loads(Path(a.ocr).read_text(encoding="utf-8"))
    result = clean_story([Path(p) for p in a.pages], ocr, a.context)
    out_path = Path(a.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")

    m = result["_meta"]
    print(f"model {m['model']}  {m['seconds']}s  tokens "
          f"{m['usage'].get('prompt_tokens', '?')}/{m['usage'].get('completion_tokens', '?')}")
    print(f"title    : {result['title']}")
    print(f"moral    : {result['moral']}")
    print(f"photo captured everything: {result['photo_complete']}")
    for pg in result["pages"]:
        print(f"  {pg['page']:22s} cut_off={str(pg['was_cut_off']):5s} "
              f"ocr_lines_recovered={pg['lines_recovered']}")
    if result["reconstructions"]:
        print(f"\n{len(result['reconstructions'])} span(s) filled in:")
        for r in result["reconstructions"]:
            print(f"  [{r['confidence']:6s}] ...{r['visible_before'][-34:]} "
                  f"<<{r['inserted']}>> {r['visible_after'][:26]}...")
            print(f"            basis: {r['basis'][:96]}")
    if result["note_for_her"]:
        print(f"\nto her: {result['note_for_her']}")
    print(f"\n--- story_text ({len(result['story_text'])} chars) ---")
    print(result["story_text"])


if __name__ == "__main__":
    main()
