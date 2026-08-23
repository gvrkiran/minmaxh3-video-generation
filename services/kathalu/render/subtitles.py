"""Subtitles for the English films.

Two things are needed and they are not the same thing. An .srt file next to the video is what
YouTube wants, because it can then show the captions as real captions and index the words.
Burned-in text is what everything else wants, because a short watched on a phone is usually
watched with the sound off and nobody turns captions on.

So both are produced: the .srt sits beside the film, and the same cues are burned into it.

The timings are exact rather than estimated. Every cue belongs to one shot whose length is
known precisely, because the shot was already cut to its own narration. Within a shot, a long
line is split into several cues in proportion to their length in characters, which is close
enough at this scale -- a shot holds one or two sentences, not a paragraph.
"""
from __future__ import annotations

import re
from pathlib import Path

# Two lines of about this width is the usual limit for something readable on a phone held at
# arm's length -- and it has to agree with the font size chosen in burn() below, or the
# renderer re-wraps and two tidy lines become four cramped ones over the picture.
LINE_CHARS = 32
MAX_LINES = 2
MIN_CUE_SECONDS = 1.2


def _wrap(text: str, width: int = LINE_CHARS) -> list[str]:
    lines, current = [], ""
    for word in text.split():
        if current and len(current) + 1 + len(word) > width:
            lines.append(current)
            current = word
        else:
            current = f"{current} {word}".strip()
    if current:
        lines.append(current)
    return lines


def _sentences(text: str) -> list[str]:
    """Split on sentence ends, keeping the punctuation."""
    parts = re.split(r"(?<=[.!?])\s+", text.strip())
    return [p for p in parts if p.strip()]


def cues_for(text: str, start: float, duration: float) -> list[tuple[float, float, str]]:
    """Turn one shot's narration into cues that fill exactly that shot's span."""
    text = " ".join(text.split())
    if not text:
        return []

    # Group sentences into blocks that fit two lines; a block is one cue.
    blocks: list[str] = []
    pending = ""
    for sentence in _sentences(text):
        candidate = f"{pending} {sentence}".strip()
        if pending and len(_wrap(candidate)) > MAX_LINES:
            blocks.append(pending)
            pending = sentence
        else:
            pending = candidate
    if pending:
        blocks.append(pending)

    # A single sentence too long for two lines still has to be broken somewhere.
    split_blocks: list[str] = []
    for block in blocks:
        lines = _wrap(block)
        while len(lines) > MAX_LINES:
            split_blocks.append(" ".join(lines[:MAX_LINES]))
            lines = lines[MAX_LINES:]
        if lines:
            split_blocks.append(" ".join(lines))

    total = sum(len(b) for b in split_blocks) or 1
    cues, at = [], start
    for i, block in enumerate(split_blocks):
        share = duration * len(block) / total
        # The last cue absorbs any rounding so the run of cues ends exactly with the shot.
        end = start + duration if i == len(split_blocks) - 1 else at + share
        if end - at >= MIN_CUE_SECONDS or not cues:
            cues.append((at, end, "\n".join(_wrap(block))))
        else:
            # Too brief to read on its own, so join it to the cue before rather than
            # flashing it. The TEXT goes with it: an earlier version merged only the
            # timing and silently dropped the words, turning "just because they have
            # grown old" into "just because they have". A subtitle that loses the end of
            # the sentence is worse than one that runs to three lines.
            prev_start, _, prev_text = cues[-1]
            merged = " ".join(prev_text.split()) + " " + block
            cues[-1] = (prev_start, end, "\n".join(_wrap(merged)))
        at = end
    return cues


def _stamp(seconds: float) -> str:
    if seconds < 0:
        seconds = 0.0
    ms = int(round(seconds * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def write_srt(segments: list[tuple[str, float]], out: Path) -> int:
    """`segments` is (narration, seconds) per piece, in the order they are joined."""
    cues: list[tuple[float, float, str]] = []
    at = 0.0
    for text, seconds in segments:
        cues.extend(cues_for(text, at, seconds))
        at += seconds

    lines = []
    for i, (start, end, text) in enumerate(cues, 1):
        lines.append(str(i))
        lines.append(f"{_stamp(start)} --> {_stamp(end)}")
        lines.append(text)
        lines.append("")
    out.write_text("\n".join(lines), encoding="utf-8")
    return len(cues)


# Burned-in styling.
#
# White on a soft dark box rather than an outline: these are bright cartoons and thin
# outlined text vanishes over pale sky.
#
# PlayResX/PlayResY are not optional. Without them libass measures FontSize against its own
# 384x288 default, so on a 480-wide film a "17pt" caption came out roughly twice the intended
# size and the renderer re-wrapped two lines into four. Setting them to the real frame makes
# FontSize mean pixels.
def style_for(width: int, height: int) -> str:
    """Caption style scaled to the frame it will be drawn on."""
    # About LINE_CHARS characters across ~88% of the width. Arial averages close to half its
    # point size per character, so size = usable_width / chars / 0.5.
    size = max(14, round(width * 0.88 / LINE_CHARS / 0.5))
    margin = round(height * 0.055)
    return (
        f"FontName=Arial,FontSize={size},PrimaryColour=&H00FFFFFF,"
        "BackColour=&HA0000000,BorderStyle=4,Outline=0,Shadow=0,"
        f"Alignment=2,MarginV={margin},MarginL=8,MarginR=8,"
        f"PlayResX={width},PlayResY={height}"
    )


def burn(video: Path, srt: Path, out: Path, run_cmd,
         width: int = 480, height: int = 864) -> Path:
    """Burn the cues into a copy of the film.

    ffmpeg's subtitles filter parses the filename itself, so a Windows path with a drive
    letter needs escaping that differs between builds. Running from the file's own directory
    and naming it plainly avoids the whole question.
    """
    run_cmd([
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-i", str(video.resolve()),
        "-vf", f"subtitles={srt.name}:force_style='{style_for(width, height)}'",
        "-c:v", "libx264", "-preset", "medium", "-crf", "19",
        "-pix_fmt", "yuv420p", "-c:a", "copy",
        "-movflags", "+faststart", str(out.resolve()),
    ], cwd=srt.parent)
    return out
