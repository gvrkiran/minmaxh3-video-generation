"""Other cuts of a film that has already been made: a 30-second short, and English narration.

The whole thing rests on one property of the existing design, which turns out to have been
worth more than it cost: the shots contain no speech. Nothing lip-syncs, the H3 prompts are
written so "the beat is carried by body language, head tilts, eye expression and gesture",
and the only audio a shot carries is its own ambience. So a rendered shot is neither Telugu
nor English, and neither long nor short. It is just a picture of something happening.

That means every variant is the same cheap operation -- write new narration, speak it, lay it
over shots that already exist -- and none of them needs the GPU to render anything again. A
90-second Telugu film becomes a 30-second English short in about a minute, against the
40 minutes it took to make in the first place.

The one real constraint is that a shot's length is already fixed. The original pipeline works
audio-first: it measures the voice and cuts the shot to fit. Here it is the other way round,
because the shot is already on disk, so the narration has to be written to a character budget
that lands inside the time available. Both speeds are measured, not guessed:

    Telugu, IndicF5   12.27 chars/sec  (+-1.3%)
    English, Piper    18.81 chars/sec  (+-6%)

English is the looser of the two, so the budget is deliberately under the shot length rather
than exactly at it -- overrunning would clip the last words off a scene.

English uses Piper rather than IndicF5, because IndicF5 covers eleven Indian languages and
English is explicitly not one of them. Piper is MIT, runs on the CPU at around forty times
real time, and being CPU-only it never has to queue behind a render for the graphics card.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import wave
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "lib"))
sys.path.insert(0, str(HERE.parent / "llm"))

from gpu_lock import GpuLock                                      # noqa: E402
from story_cleanup import MODEL, call_openai                      # noqa: E402
import moral_card                                                 # noqa: E402
import subtitles                                                  # noqa: E402
from pipeline import (                                            # noqa: E402
    MEGAPIXELS, StoryLock, media_seconds, resolution, run_cmd,
)

CHARS_PER_SEC = {"te": 12.27, "en": 18.81}
SHORT_SECONDS = 30

# Leave room for the spread in speaking rate. Without it a scene whose narration lands 6%
# long has its last words cut off by the shot ending.
FIT = 0.88

# Air after the last syllable of a trimmed shot, so a short does not cut on the final word.
SHORT_TAIL = 0.7

# Everything that is not narration still costs seconds, and budgeting only the words is how a
# "30-second" short came out at 36. Measured on a real one: the closing card runs about 6s
# (spoken lesson plus the hold), and each shot keeps SHORT_TAIL of air after its last
# syllable. Four shots is the usual answer, so that is what the budget assumes.
MORAL_SECONDS = 6
TYPICAL_SHOTS = 4

VOICE_EN = Path("H:/KathaluStudio/voices-en/en_GB-jenny_dioco-medium.onnx")
TOOLS_PY = Path("H:/KathaluStudio/ocr-venv/Scripts/python.exe")
INDIC_PY = Path("H:/H3RemoteStudio/IndicF5/venv/Scripts/python.exe")
HF_HOME = Path("H:/H3RemoteStudio/IndicF5/hf-cache")

LANGUAGE_NAME = {"te": "Telugu", "en": "English"}


# ----------------------------------------------------------------- planning the cut

PLAN_RULES = """You are re-cutting a finished children's film.

The pictures are already made and cannot change. You are choosing which of them to use and
writing what the narrator says over each one. Two hard rules follow from that:

1. Every shot has a FIXED length, given to you in seconds along with a character budget.
   Write narration for each chosen shot that fits inside its budget. Going over means the
   last words are cut off mid-sentence when the picture ends. Slightly under is fine.
2. You cannot describe anything that is not in the shot you were given. Each shot comes with
   a description of what happens in it. The narration must match that picture.

%(job)s

WRITING THE NARRATION
- %(language)s only.%(script_rule)s
- Plain spoken register, the way a grandmother reads aloud to a child. Not literary.
- Third person past tense. Report speech rather than performing it, because nobody's mouth
  moves on screen.
- It must stand on its own: somebody who has not seen the long film should follow it."""

JOB_FULL = """THE JOB: the whole story, one narration per shot, in order. Use every shot."""

JOB_SHORT = """THE JOB: a %(seconds)d-second version for social media.

Choose the smallest set of shots, in their original order, that still tells a whole story --
a beginning, the turn, and how it ends. Three or four is usually right.

Each shot will be CUT DOWN to the length of the narration you write over it, so what decides
the running time is your words, not the shot lengths. Write about %(spoken)d seconds of
narration in total across all the chosen shots -- about %(chars)d characters ALTOGETHER,
counting every shot. The closing lesson card takes the rest of the %(seconds)d seconds. Each shot's budget is still a ceiling you cannot exceed, because a
shot cannot be made longer than it is.

This is a condensation, not an excerpt. Somebody watching only this should get the entire
story and the lesson, so the narration over each chosen shot has to carry the parts you
skipped. Do not simply reuse the long film's wording."""

SCRIPT_RULE_TE = ("""
- Telugu in native script only. No Roman letters anywhere, not even for names. No digits:
  write numbers as Telugu words.""")
SCRIPT_RULE_EN = ("""
- Natural English. Keep the Indian names as they are.""")

SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "title": {"type": "string", "description": "The story's title in the chosen language."},
        "moral": {"type": "string", "description": "The lesson, one short sentence, in the "
                                                   "chosen language."},
        "beats": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "scene": {"type": "integer",
                              "description": "The index of the shot this narrates."},
                    "narration": {"type": "string"},
                },
                "required": ["scene", "narration"],
            },
        },
    },
    "required": ["title", "moral", "beats"],
}


def shot_menu(story_dir: Path, script: dict) -> list[dict]:
    """Every shot that actually exists, with its real length off disk."""
    menu = []
    for scene in script["scenes"]:
        idx = scene["index"]
        shot = story_dir / "shots" / f"scene_{idx:02d}.mp4"
        if not shot.exists():
            continue
        menu.append({
            "scene": idx,
            "seconds": round(media_seconds(shot), 2),
            "what_happens": scene.get("summary_for_her", ""),
        })
    return menu


def plan(script: dict, menu: list[dict], kind: str, language: str) -> dict:
    rate = CHARS_PER_SEC[language]
    ceiling = {m["scene"]: int(m["seconds"] * rate * FIT) for m in menu}
    if kind == "short":
        # Share the whole spoken budget across the shots it will pick, and never exceed what
        # a given shot can physically hold. Offering each shot its own full length instead
        # produced four full-length scenes and a 36-second "short".
        share = int(round(SHORT_SECONDS - MORAL_SECONDS - TYPICAL_SHOTS * SHORT_TAIL)
                    * rate / TYPICAL_SHOTS)
        offer = [{**m, "character_budget": min(ceiling[m["scene"]], share)} for m in menu]
    else:
        offer = [{**m, "character_budget": ceiling[m["scene"]]} for m in menu]
    spoken_budget = round(SHORT_SECONDS - MORAL_SECONDS - TYPICAL_SHOTS * SHORT_TAIL)
    job = (JOB_SHORT % {"seconds": SHORT_SECONDS, "spoken": spoken_budget,
                        "chars": int(spoken_budget * rate)}
           ) if kind == "short" else JOB_FULL
    rules = PLAN_RULES % {
        "job": job,
        "language": LANGUAGE_NAME[language],
        "script_rule": SCRIPT_RULE_TE if language == "te" else SCRIPT_RULE_EN,
    }
    got = call_openai({
        "model": MODEL,
        "reasoning_effort": "low",
        "messages": [
            {"role": "system", "content": rules},
            {"role": "user", "content": json.dumps({
                "story_title": script.get("title", ""),
                "the_lesson": script.get("moral_english") or script.get("telugu_moral", ""),
                "shots_available": offer,
                "total_length_if_you_use_them_all":
                    round(sum(m["seconds"] for m in menu), 1),
            }, ensure_ascii=False, indent=1)},
        ],
        "response_format": {"type": "json_schema", "json_schema": {
            "name": "cut", "strict": True, "schema": SCHEMA}},
    })
    out = json.loads(got["choices"][0]["message"]["content"])
    out["_usage"] = got.get("usage", {})
    return out


def spoken_seconds_budget() -> float:
    """Seconds of actual speech a short can hold, once the card and the tails are paid for."""
    return SHORT_SECONDS - MORAL_SECONDS - TYPICAL_SHOTS * SHORT_TAIL


def check(cut: dict, menu: list[dict], language: str, kind: str = "full") -> list[str]:
    """Refuse a cut that would be clipped, rather than shipping half a sentence."""
    rate = CHARS_PER_SEC[language]
    by_scene = {m["scene"]: m for m in menu}
    problems = []
    for beat in cut["beats"]:
        shot = by_scene.get(beat["scene"])
        if shot is None:
            problems.append(f"beat refers to scene {beat['scene']}, which has no shot")
            continue
        spoken = len(beat["narration"]) / rate
        if spoken > shot["seconds"]:
            problems.append(
                f"scene {beat['scene']}: narration takes ~{spoken:.1f}s but the shot is only "
                f"{shot['seconds']:.1f}s")
        if language == "te" and any("a" <= c.lower() <= "z" for c in beat["narration"]):
            problems.append(f"scene {beat['scene']}: Telugu narration contains Roman letters")
    if not cut["beats"]:
        problems.append("the cut has no shots in it")

    # The point of a short is its length, so check the thing that decides it. Left unchecked,
    # it wrote about a third more than the budget said and a "30-second" short came out at 36.
    if kind == "short" and cut["beats"]:
        total = sum(len(b["narration"]) for b in cut["beats"]) / rate
        allowed = spoken_seconds_budget()
        if total > allowed * 1.1:
            problems.append(
                f"the narration totals ~{total:.0f}s of speech but a {SHORT_SECONDS}s short "
                f"only has room for ~{allowed:.0f}s once the lesson card is counted")
    return problems


# ----------------------------------------------------------------- speaking it

def speak_english(texts: dict[str, str], out_dir: Path) -> None:
    """Piper, on the CPU. No GPU lock -- this can run while a film is rendering."""
    out_dir.mkdir(parents=True, exist_ok=True)
    todo = {name: text for name, text in texts.items()
            if not (out_dir / f"{name}.wav").exists()}
    if not todo:
        print("  english voice: all cached")
        return
    script = HERE / "_speak_piper.py"
    payload = json.dumps({"model": str(VOICE_EN), "out": str(out_dir), "texts": todo})
    done = subprocess.run([str(TOOLS_PY), str(script)], input=payload,
                          capture_output=True, text=True, encoding="utf-8")
    if done.returncode != 0:
        raise RuntimeError("English narration failed:\n" + (done.stderr or "")[-2000:])
    for line in (done.stdout or "").splitlines():
        if line.strip():
            print(f"  {line}")


def speak_telugu(cut: dict, work: Path, voice: str) -> None:
    """IndicF5, which is a GPU model, so this waits its turn like any other GPU stage."""
    shim = {
        "scenes": [{
            "index": b["scene"],
            "telugu_narration": b["narration"],
            "narration_chars": len(b["narration"]),
            "estimated_seconds": round(len(b["narration"]) / CHARS_PER_SEC["te"], 2),
        } for b in cut["beats"]],
        "telugu_moral": cut.get("moral", ""),
    }
    shim_path = work / "script.json"
    shim_path.write_text(json.dumps(shim, ensure_ascii=False, indent=2), encoding="utf-8")
    env = {**os.environ, "HF_HOME": str(HF_HOME), "HF_HUB_CACHE": str(HF_HOME / "hub"),
           "HF_HUB_OFFLINE": "1", "PYTHONIOENCODING": "utf-8"}
    done = subprocess.run(
        [str(INDIC_PY), str(HERE / "narrate.py"),
         "--script", str(shim_path), "--dir", str(work), "--voice", voice],
        env=env, capture_output=True, text=True, encoding="utf-8", errors="replace")
    for line in (done.stdout or "").splitlines():
        if line.strip():
            print(f"  {line}")
    if done.returncode != 0:
        raise RuntimeError("Telugu narration failed:\n" + (done.stderr or "")[-2000:])


# ----------------------------------------------------------------- assembling it

def build(story_dir: Path, cut: dict, work: Path, aspect: str, out: Path,
          trim: bool = False, subtitle: bool = False) -> Path:
    """Lay the narration over the existing shots.

    `trim` decides which of the two lengths wins. The long film pads the voice out to the
    shot, because the shot is the film and its pacing is deliberate. A short does the
    opposite and cuts the shot down to the voice: the first attempt left 3.7 seconds of
    silence at the end of one scene and ran to 38 seconds instead of 30, which is dead air
    in the one format where nobody waits.
    """
    narrated = work / "narrated"
    narrated.mkdir(parents=True, exist_ok=True)
    parts = []
    # What is said over each joined piece, and for how long. Collected here because this is
    # the only place that knows the final lengths -- a short's shots are trimmed to the voice.
    spoken: list[tuple[str, float]] = []
    for beat in cut["beats"]:
        idx = beat["scene"]
        shot = story_dir / "shots" / f"scene_{idx:02d}.mp4"
        wav = work / "narration" / f"scene_{idx:02d}.wav"
        piece = narrated / f"scene_{idx:02d}.mp4"
        shot_seconds = media_seconds(shot)
        target = shot_seconds
        if trim:
            voice_seconds = media_seconds(wav)
            target = min(shot_seconds, voice_seconds + SHORT_TAIL)
        if not piece.exists():
            run_cmd(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                     "-i", str(shot), "-i", str(wav),
                     "-filter_complex", f"[1:a]apad,atrim=0:{target:.5f}[voice]",
                     "-map", "0:v:0", "-map", "[voice]",
                     "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
                     "-movflags", "+faststart", "-t", f"{target:.5f}", str(piece)])
        parts.append(piece)
        spoken.append((beat["narration"], target))
        note = f" (cut from {shot_seconds:.1f}s)" if trim and target < shot_seconds - 0.05 else ""
        print(f"  scene {idx:2d}  {target:6.2f}s  narrated{note}")

    moral_wav = work / "narration" / "moral.wav"
    if (cut.get("moral") or "").strip() and moral_wav.exists():
        card = narrated / "zz_moral.mp4"
        if not card.exists():
            width, height = resolution(aspect, MEGAPIXELS)
            moral_card.build_segment(
                telugu=cut["moral"], english="", audio=moral_wav,
                width=width, height=height, out=card, run_cmd=run_cmd)
        parts.append(card)
        spoken.append((cut["moral"], media_seconds(card)))

    listing = work / "concat.txt"
    listing.write_text("".join(f"file '{p.as_posix()}'\n" for p in parts), encoding="utf-8")
    run_cmd(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
             "-f", "concat", "-safe", "0", "-i", str(listing),
             "-c:v", "libx264", "-preset", "medium", "-crf", "19",
             "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k",
             "-movflags", "+faststart", str(out)])

    if subtitle:
        # Both, because they are wanted for different things: YouTube takes the .srt as real
        # captions it can index, and everywhere else the words have to be in the picture,
        # since a short on a phone is usually watched with the sound off.
        srt = out.with_suffix(".srt")
        count = subtitles.write_srt(spoken, srt)
        burned = out.with_name(out.stem + "-subtitled.mp4")
        # The real frame, not the aspect setting: the caption size is computed from it.
        width, height = resolution(aspect, MEGAPIXELS)
        subtitles.burn(out, srt, burned, run_cmd, width, height)
        print(f"  subtitles: {count} caption(s) -> {srt.name} and {burned.name}")
    return out


def make(story_dir: Path, kind: str, language: str, aspect: str, voice: str,
         force: bool = False) -> Path:
    script = json.loads((story_dir / "script.json").read_text(encoding="utf-8"))
    out = story_dir / f"final-{language}-{kind}.mp4"
    if out.exists() and not force:
        print(f"{out.name} already exists")
        return out

    menu = shot_menu(story_dir, script)
    if not menu:
        raise SystemExit("this story has no rendered shots yet, so there is nothing to re-cut")
    print(f"{kind} / {LANGUAGE_NAME[language]}  --  {len(menu)} shot(s) available, "
          f"{sum(m['seconds'] for m in menu):.0f}s of film")

    work = story_dir / "variants" / f"{language}-{kind}"
    if force and work.exists():
        # Everything under here is cached by existence -- the cut plan, the wavs, the muxed
        # pieces. Regenerating only the plan left the old audio and video in place, so a
        # forced rebuild produced a byte-identical film and looked like the change had not
        # worked. Force has to mean the whole variant.
        import shutil
        shutil.rmtree(work)
    work.mkdir(parents=True, exist_ok=True)
    plan_path = work / "cut.json"
    if plan_path.exists() and not force:
        cut = json.loads(plan_path.read_text(encoding="utf-8"))
        print("  cut plan cached")
    else:
        cut = plan(script, menu, kind, language)
        problems = check(cut, menu, language, kind)
        if problems:
            # One retry, telling it exactly what overran. Failing outright would mean a
            # backfill of a dozen films dying on one long sentence.
            print("  re-planning: " + "; ".join(problems[:3]), flush=True)
            cut = plan(script, menu, kind, language)
            problems = check(cut, menu, language, kind)
            if problems:
                raise SystemExit("could not fit the narration: " + "; ".join(problems))
        plan_path.write_text(json.dumps(cut, ensure_ascii=False, indent=2), encoding="utf-8")

    chosen = [b["scene"] for b in cut["beats"]]
    length = sum(m["seconds"] for m in menu if m["scene"] in chosen)
    print(f"  {len(chosen)} shot(s): {chosen}  =  {length:.1f}s")

    if language == "en":
        texts = {f"scene_{b['scene']:02d}": b["narration"] for b in cut["beats"]}
        if (cut.get("moral") or "").strip():
            texts["moral"] = cut["moral"]
        speak_english(texts, work / "narration")
    else:
        with GpuLock(f"the {kind} {LANGUAGE_NAME[language]} version",
                     story=script.get("title") or story_dir.name):
            speak_telugu(cut, work, voice)

    # Subtitles for the English films only: the Telugu ones are watched by people who speak
    # Telugu, and burning Telugu text over the picture would need the shaping work the moral
    # card does rather than ffmpeg's own renderer.
    build(story_dir, cut, work, aspect, out, trim=(kind == "short"),
          subtitle=(language == "en"))
    print(f"  -> {out.name}  {media_seconds(out):.1f}s")
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--story-dir", required=True)
    ap.add_argument("--kind", default="short", choices=["full", "short"])
    ap.add_argument("--language", default="en", choices=["te", "en"])
    ap.add_argument("--aspect", default="9:16", choices=["9:16", "16:9"])
    ap.add_argument("--voice", default="female", choices=["female", "male"])
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args()

    story_dir = Path(a.story_dir)
    # The same per-story lock the renderer uses, so a variant and a rebuild cannot both be
    # writing into one story.
    with StoryLock(story_dir):
        make(story_dir, a.kind, a.language, a.aspect, a.voice, a.force)


if __name__ == "__main__":
    main()
