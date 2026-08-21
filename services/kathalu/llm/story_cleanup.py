"""Kathalu Studio -- turn the transcribed pages into one clean, complete story.

The pages themselves are read by llm/transcribe.py, which asks the model to copy out only
what is visibly printed. There used to be a local OCR pass in front of this (RapidOCR, in
its own venv) and it is gone, because it could not do the job: the only recogniser bundled
with it is a Chinese/English model whose vocabulary holds no Indic characters at all, so on
a Telugu page it returned Latin letters that merely resembled the glyph shapes. Probed with
a flawless 72px render it returns English exactly and Telugu not at all. It also read
two-column pages row by row, interleaving the columns into nonsense. Feeding that to the
model was worse than feeding it nothing.

So this step no longer repairs a bad transcript. It takes a good one and makes a story of
it: joins the pages, fixes the layout artefacts of print, separates the moral from the body,
and completes the short spans that the camera clipped off a margin.

Two safeguards, and they do different jobs:

  * Disclosure, for small gaps. Every span filled in is recorded in `reconstructions` with
    the words surrounding it, so the review screen can show her exactly what was supplied
    and let her correct it before anything is animated.

  * Refusal, for large ones. A page that cannot be read is not completed at any confidence
    -- transcribe.py stops the whole ingest first. That rule exists because the licence to
    reconstruct large gaps once turned four unreadable photographs into a fluent, complete,
    entirely different story, reported as complete.

Usage:
  OPENAI_API_KEY=... python story_cleanup.py \
      --pages story4_1.jpeg story4_2.jpeg --out story.json
"""
from __future__ import annotations

import argparse
import sys
import base64
import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path

API = "https://api.openai.com/v1/chat/completions"
MODEL = os.environ.get("KATHALU_TEXT_MODEL", "gpt-5.5")
# Low, measured on her real Telugu page. This stage no longer reads the photograph -- the
# page arrives already transcribed -- so what is left is joining pages, tidying print
# artefacts and translating, and it does not need deliberation:
#
#   default effort  279s for the cleanup call, 6,655 of its 7,807 output tokens reasoning
#   low effort      whole ingest 111s instead of 311s
#   medium effort   452s, which EXCEEDED the 420s HTTP timeout and failed outright
#
# So the default was both the slowest and the closest to timing out.
CLEAN_EFFORT = os.environ.get("KATHALU_CLEAN_EFFORT", "low").strip()

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

WORK ONLY FROM THE TRANSCRIPTION
The verbatim transcription supplied with each page is your only source for what the story
says. You have the photographs too, and you should consult them, but only to read the page
better -- never to remember it. If you recognise the tale as one you know, that recognition
is not evidence: a remembered version has different names, a different village and a
different ending, and using it gives her a video of a story she never photographed.

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
  side of it, so a person can check each one. This is not optional bookkeeping -- it is the
  only way she ever finds out. `reconstructions` and `note_for_her` must agree: if the note
  says you filled anything in, the spans must be listed, and if you listed no spans the note
  must not claim you filled anything. Saying you supplied words without saying WHICH words
  leaves her with a story she has been told to check and no way to check it.
- If something much larger is absent -- a whole paragraph, or the end of the story -- do
  NOT reconstruct it. Leave the gap, set `photo_complete` to false, and tell her plainly in
  `note_for_her` which page is incomplete and that she should photograph it again. This rule
  used to say to reconstruct large gaps where the narrative implied them. On a page where
  only a fifth was legible that produced a fluent, complete, entirely different story,
  reported as complete. A story with an acknowledged hole is recoverable; a confident
  substitution is not.

The OCR hints flag sides where lines merely REACH the edge of the photograph. That is a
suspicion, not a fact: text can sit close to a margin and still be complete. Judge from
the image. If the words at that edge are whole, nothing was cut and nothing needs filling.

IF THE PAGE IS NOT IN ENGLISH
`story_text`, `title` and `moral` always hold the story in the language it was PRINTED in.
Never translate those. If that language is not English, also fill `story_english` and
`title_english` (and `moral_english`, if a moral was printed).

The English is what the image and video models are given, so it has to carry everything
they need to draw: who is in each event, what they do, what they look like. Translate the
whole story faithfully and completely -- same events, same order, same characters, nothing
summarised away and nothing added. Natural English prose at the same reading level, not a
word-for-word gloss. If the story was printed in English, leave these three fields empty.

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
        "language": {"type": "string",
                     "description": "The language the page was printed in, e.g. English, "
                                    "Telugu, Hindi."},
        "story_english": {
            "type": "string",
            "description": "A faithful, complete English translation of story_text -- but "
                           "EMPTY if the page was already in English.",
        },
        "title_english": {"type": "string",
                          "description": "The title in English, or empty if already English."},
        "moral_english": {"type": "string",
                          "description": "The printed moral in English, or empty."},
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
    "required": ["title", "story_text", "moral", "language",
                 "story_english", "title_english", "moral_english", "photo_complete",
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
            with urllib.request.urlopen(req, timeout=600) as r:
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


def clean_story(page_paths: list[Path], context: str = DEFAULT_CONTEXT) -> dict:
    # Read the pages literally FIRST, and stop here if they cannot be read. Without this
    # step an unreadable page does not fail -- it comes back as a different story that the
    # model knew by heart, marked complete. See llm/transcribe.py.
    from transcribe import GAP, transcribe
    read = transcribe(page_paths)

    preamble = (
        f"This story spans {len(page_paths)} page(s), given in reading order."
        f" Printed in: {read['language'] or 'unknown'}."
        f" Column layout: {read['columns']}."
        " A verbatim transcription of each page follows. It is the ONLY source for the"
        f" story. Anything marked {GAP} was not readable in the photograph."
    )
    content: list[dict] = [{"type": "text", "text": preamble}]
    for i, (path, page) in enumerate(zip(page_paths, read["pages"]), 1):
        header = f"--- PAGE {i} of {len(page_paths)} ---"
        content.append({"type": "text", "text": header + chr(10) + json.dumps({
            "page": path.name,
            "columns": page.get("column_count"),
            "fraction_legible": page.get("fraction_legible"),
            "unreadable_spans": page.get("unreadable_spans"),
            "verbatim_transcription": page.get("text", ""),
        }, ensure_ascii=False, indent=1)})
        content.append({"type": "image_url",
                        "image_url": {"url": data_url(path), "detail": "high"}})

    started = time.time()
    payload_extra = {"reasoning_effort": CLEAN_EFFORT} if CLEAN_EFFORT else {}
    got = call_openai({
        "model": MODEL,
        **payload_extra,
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
    # If it claims a fill in the note but lists no spans, she has been told to check
    # something she cannot see. Surface that rather than letting it pass quietly.
    claims_fill = any(w in (out.get("note_for_her") or "").lower()
                      for w in ("filled", "fill in", "filled in", "supplied", "added"))
    if claims_fill and not out.get("reconstructions"):
        out["disclosure_incomplete"] = True
        print("WARNING: note_for_her claims words were filled in but reconstructions is "
              "empty -- she cannot check what she is being asked to check", flush=True)

    # Kept on the record so "why is this story wrong" stays answerable later.
    out["_read"] = {
        "seconds": read["seconds"],
        "fraction_legible": read["fraction_legible"],
        "columns": read["columns"],
        "language_seen": read["language"],
        "per_page": {pg["page"]: pg["fraction_legible"] for pg in read["pages"]},
    }
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pages", nargs="+", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--context", default=DEFAULT_CONTEXT)
    a = ap.parse_args()

    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from transcribe import PageTooHard
    try:
        result = clean_story([Path(p) for p in a.pages], a.context)
    except PageTooHard as too_hard:
        # A structured refusal, not a crash: the route turns this into plain advice about
        # retaking the photograph.
        payload = {"error": "photos_unreadable", "message": str(too_hard),
                   **too_hard.detail}
        print("PAGES_UNREADABLE " + json.dumps(payload, ensure_ascii=False), flush=True)
        raise SystemExit(3)
    out_path = Path(a.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")

    m = result["_meta"]
    print(f"model {m['model']}  {m['seconds']}s  tokens "
          f"{m['usage'].get('prompt_tokens', '?')}/{m['usage'].get('completion_tokens', '?')}")
    print(f"title    : {result['title']}")
    print(f"moral    : {result['moral']}")
    print(f"photo captured everything: {result['photo_complete']}")
    r = result.get("_read", {})
    print(f"legible: {r.get('fraction_legible')}  columns: {r.get('columns')}  "
          f"language: {r.get('language_seen')}")
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
