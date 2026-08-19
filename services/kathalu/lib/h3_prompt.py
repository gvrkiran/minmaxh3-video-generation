"""Assemble and validate MiniMax H3 reference-to-video prompts.

Deliberately NOT the language model's job. The subject_definitions and
retention_analysis blocks are built here, from the library records, so they come out
byte-identical for the same character in every shot of a story. Identity stability across
independently-generated shots is the biggest visual risk in this pipeline, and letting a
model re-improvise those blocks per shot would undermine it for no benefit. The model
writes the action prose and the Telugu; the skeleton is mechanical.

The rules encoded here were learned expensively in h3-remote-studio and phase 0:
  * A real character name anywhere in the prompt makes H3 substitute its own idea of that
    character and ignore the supplied reference image. Names survive ONLY inside a spoken
    <d> tag. Everything else is <Subject N>.
  * Section order is mandatory, `summary:` must open with [reference generation], and
    retention_analysis has one exact `fully_preserved` line per subject.
  * Frames sit on a 17k+5 grid at 24 fps, trained range 124-362 (5.17-15.08 s).
  * At most 9 reference images.
"""
from __future__ import annotations

import re

FPS = 24
MIN_FRAMES, MAX_FRAMES = 124, 362
MAX_REFS = 9

SECTIONS = ("subject_definitions:", "summary:", "retention_analysis:",
            "detailed_description:", "overall_soundscape:", "non_diegetic_music:")

TELUGU = r"ఀ-౿"
DIALOGUE_RE = re.compile(r"<d>.*?</d>", re.S | re.I)
SUBJECT_RE = re.compile(r"<Subject\s+(\d+)>", re.I)
PICTURE_RE = re.compile(r"<Picture\s+(\d+)>", re.I)

# Words that are roles or species rather than identities; safe to appear in prose.
GENERIC = {
    "the", "a", "an", "old", "young", "three", "two", "first", "second", "third",
    "priest", "king", "queen", "prince", "princes", "minister", "ministers", "advisor",
    "advisors", "teacher", "guru", "pandit", "merchant", "farmer", "thief", "thieves",
    "hunter", "washerman", "barber", "boy", "girl", "man", "woman", "sons", "son",
    "fox", "stork", "goat", "lion", "donkey", "jackal", "crow", "monkey", "rabbit",
    "hare", "tortoise", "elephant", "mouse", "rat", "snake", "crane", "deer", "bull",
    "cat", "dog", "tiger", "wolf", "bear", "camel", "horse", "cow", "calf", "swan",
    "pigeon", "sparrow", "frog", "fish", "bird", "animal", "animals",
}


def frames_for(seconds: float) -> int:
    """Snap a duration up onto H3's 17k+5 grid, clamped to the trained range."""
    n = max(5, round(seconds * FPS))
    n += (5 - (n % 17)) % 17
    return max(MIN_FRAMES, min(MAX_FRAMES, n))


def seconds_for(frames: int) -> float:
    return frames / FPS


def identity_words(name: str) -> list[str]:
    """The parts of a character's name that would activate a model prior."""
    return [w for w in re.split(r"[^A-Za-z]+", name)
            if len(w) >= 3 and w.lower() not in GENERIC]


def build_prompt(*, action: str, subjects: list[dict], soundscape: str, music: str,
                 telling_mode: str = "silent", dialogue: str = "") -> str:
    """subjects: ordered library records; index i becomes <Subject i+1> / <Picture i+1>."""
    defs, retention = [], []
    for i, s in enumerate(subjects, 1):
        defs.append(
            f"<Subject {i}> is the character in <Picture {i}>. {s['description'].rstrip('. ')}. "
            f"<Picture {i}> is the sole source of this subject's identity and visual style; "
            f"do not infer culturally associated features, clothing, headwear or jewellery."
        )
        retention.append(
            f"<Subject {i}> (appears in [Shot 1]): fully_preserved - preserve the exact face, "
            f"colours, markings, body proportions, costume and illustration style from "
            f"<Picture {i}>; do not reinterpret, do not blend with any other subject, do not "
            f"add unreferenced clothing or accessories, and do not restyle photographically."
        )

    body = action.rstrip()
    if telling_mode == "silent":
        body += (
            " No character speaks and no character opens its mouth to talk at any point in "
            "the shot: no visible speech, no lip movement, no mouth articulation. The whole "
            "beat is carried by body language, head tilts, eye expression and gesture."
        )
    elif dialogue:
        body += " " + dialogue.rstrip()

    return (
        "subject_definitions:\n" + "\n".join(defs) + "\n\n"
        "summary:\n[reference generation] Generate the requested scene using only the "
        "defined subjects as the visual identity sources.\n\n"
        "retention_analysis:\n" + "\n".join(retention) + "\n\n"
        "detailed_description:\n[Shot 1] " + body + "\n\n"
        f"overall_soundscape: {soundscape.rstrip('. ')}.\n"
        f"non_diegetic_music: {music.rstrip('. ')}.\n"
    )


def validate_prompt(prompt: str, subjects: list[dict], telling_mode: str = "silent") -> list[str]:
    errors: list[str] = []

    # -- section order, exactly once each, in sequence
    positions = []
    for section in SECTIONS:
        hits = [m.start() for m in re.finditer(re.escape(section), prompt)]
        if not hits:
            errors.append(f"missing section: {section}")
        elif len(hits) > 1:
            errors.append(f"section repeated {len(hits)}x: {section}")
        else:
            positions.append((section, hits[0]))
    if len(positions) == len(SECTIONS):
        order = [s for s, _ in sorted(positions, key=lambda kv: kv[1])]
        if order != list(SECTIONS):
            errors.append("sections out of order: " + " -> ".join(s.rstrip(':') for s in order))

    if "summary:" in prompt:
        tail = prompt.split("summary:", 1)[1].lstrip()
        if not tail.startswith("[reference generation]"):
            errors.append("summary: must open with [reference generation]")
    if "[Shot 1]" not in prompt:
        errors.append("detailed_description: must contain [Shot 1]")

    # -- one exact fully_preserved line per subject
    for i in range(1, len(subjects) + 1):
        needle = f"<Subject {i}> (appears in [Shot 1]): fully_preserved - "
        if needle not in prompt:
            errors.append(f"retention_analysis: missing exact fully_preserved line for <Subject {i}>")

    # -- subject / picture numbering
    used_subjects = {int(n) for n in SUBJECT_RE.findall(prompt)}
    expected = set(range(1, len(subjects) + 1))
    if used_subjects - expected:
        errors.append(f"references undefined subjects: {sorted(used_subjects - expected)}")

    # "never used" has to be judged on the action alone. The definition and retention
    # blocks name every subject by construction, so checking the whole prompt made this
    # test vacuous -- a subject supplied as a reference but absent from the shot slipped
    # through, wasting a reference slot and risking H3 inserting them anyway.
    action_only = prompt.split("detailed_description:", 1)[-1].split("overall_soundscape:", 1)[0]
    acted = {int(n) for n in SUBJECT_RE.findall(action_only)}
    if expected - acted:
        errors.append(f"defined but never used in the shot: {sorted(expected - acted)}")
    bad_pics = {int(n) for n in PICTURE_RE.findall(prompt)} - expected
    if bad_pics:
        errors.append(f"references <Picture {sorted(bad_pics)}> but only {len(subjects)} refs supplied")
    if len(subjects) > MAX_REFS:
        errors.append(f"{len(subjects)} reference images exceeds the node limit of {MAX_REFS}")

    # -- the big one: no real names outside a <d> tag
    outside = DIALOGUE_RE.sub(" ", prompt)
    for s in subjects:
        for word in identity_words(s.get("name", "")):
            if re.search(rf"\b{re.escape(word)}\b", outside, re.I):
                errors.append(f"character name '{word}' appears in the prompt outside a <d> tag "
                              f"-- H3 will substitute its own idea of the character")

    # -- telling mode
    has_dialogue = bool(DIALOGUE_RE.search(prompt))
    if telling_mode == "silent" and has_dialogue:
        errors.append("telling_mode is silent but the prompt contains a <d> dialogue tag")
    if telling_mode == "dialogue" and not has_dialogue:
        errors.append("telling_mode is dialogue but the prompt contains no <d> tag")
    for tag in DIALOGUE_RE.findall(prompt):
        if not re.match(r"<d>\s*\[[A-Za-z]+\]\s*\S", tag):
            errors.append(f"dialogue tag missing its [Language] prefix: {tag[:60]}")
    if '"' in outside.replace('\\"', ""):
        errors.append("straight quotation marks in the prompt -- dialogue must use <d> tags")

    return errors


def validate_narration(text: str, chars_per_second: float,
                       soft_chars: int, hard_chars: int) -> list[str]:
    """Clean Telugu, and short enough to fit a shot without time-stretching."""
    errors: list[str] = []
    if not text.strip():
        errors.append("narration is empty")
        return errors
    if re.search(r"[A-Za-z]", text):
        found = "".join(sorted(set(re.findall(r"[A-Za-z]", text))))[:12]
        errors.append(f"narration contains Roman letters ({found}) -- must be Telugu script only")
    if re.search(r"[0-9]", text):
        errors.append("narration contains digits -- numbers must be written as Telugu words")
    if not re.search(f"[{TELUGU}]", text):
        errors.append("narration contains no Telugu characters at all")
    n = len(text)
    if n > hard_chars:
        errors.append(f"narration is {n} chars (~{n / chars_per_second:.1f}s), over the "
                      f"{hard_chars}-char ceiling for a {MAX_FRAMES}-frame shot")
    return errors
