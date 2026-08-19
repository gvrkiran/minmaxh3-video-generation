"""Build the closing moral card as a narrated video segment.

Deliberately not an H3 render. The card is text on a plain ground, so a still image plus the
narrated Telugu costs a couple of seconds of ffmpeg rather than four and a half minutes of
GPU, and the text comes out actually readable -- a video model asked for writing produces
something that merely resembles it.

Telugu is drawn through HarfBuzz and FreeType (see text_shaping), not Pillow's own text
drawing, because Pillow here has no shaper and renders Indic conjuncts malformed.
"""
from __future__ import annotations

from pathlib import Path

import text_shaping as shaping

# Windows keeps its Indic coverage in a font *collection*, not a .ttf: the Telugu glyphs live
# in Nirmala.ttc and the family variants are selected by index. Guessing "gautami.ttf" found
# nothing at all. These were verified against the cmap for U+0C28 rather than assumed.
# Forward slashes throughout -- Windows and FreeType both accept them.
TELUGU_FONTS = [
    ("C:/Windows/Fonts/Nirmala.ttc", 0),                    # Nirmala UI
    ("C:/Windows/Fonts/Nirmala.ttc", 3),                    # Nirmala Text
    ("C:/Windows/Fonts/NotoSansTelugu-Regular.ttf", 0),
    ("C:/Windows/Fonts/gautami.ttf", 0),
]
LATIN_FONTS = [
    ("C:/Windows/Fonts/segoeui.ttf", 0),
    ("C:/Windows/Fonts/calibri.ttf", 0),
    ("C:/Windows/Fonts/arial.ttf", 0),
]

PAPER = (247, 243, 236)      # warm off-white, like the storybook page
INK = (30, 42, 46)
SUBDUED = (110, 122, 126)
ACCENT = (194, 105, 26)


def _first_present(candidates):
    """-> (path, face_index) for the first candidate actually installed."""
    return next(((path, index) for path, index in candidates if Path(path).exists()), None)


def render_card(*, telugu: str, english: str, width: int, height: int, out: Path) -> Path:
    """The Telugu moral large, the English beneath a short rule, centred on warm paper."""
    from PIL import Image

    telugu_face = _first_present(TELUGU_FONTS)
    if telugu_face is None:
        raise RuntimeError("No Telugu-capable font found. Looked for: "
                           + ", ".join(path for path, _ in TELUGU_FONTS))
    latin_face = _first_present(LATIN_FONTS) or telugu_face

    image = Image.new("RGB", (width, height), PAPER)
    margin = int(width * 0.09)
    inner = width - 2 * margin

    te_px = max(20, int(width * 0.058))
    la_px = max(13, int(width * 0.034))
    te_lines = shaping.wrap(telugu, *telugu_face, te_px, inner)
    la_lines = shaping.wrap(english, *latin_face, la_px, inner) if english else []

    te_step = int(te_px * 1.62)
    la_step = int(la_px * 1.55)
    rule_gap = int(te_px * 0.95)
    block = len(te_lines) * te_step + (rule_gap + len(la_lines) * la_step if la_lines else 0)
    y = (height - block) // 2 + int(te_px * 0.85)      # first baseline, not first top

    for line in te_lines:
        wide = shaping.measure(line, *telugu_face, te_px)
        shaping.draw(image, line, *telugu_face, te_px,
                     ((width - wide) / 2, y), INK)
        y += te_step

    if la_lines:
        from PIL import ImageDraw
        y += rule_gap // 2 - int(te_px * 0.5)
        rule = int(inner * 0.2)
        ImageDraw.Draw(image).line(
            [((width - rule) / 2, y), ((width + rule) / 2, y)], fill=ACCENT, width=3)
        y += rule_gap // 2 + int(la_px * 0.9)
        for line in la_lines:
            wide = shaping.measure(line, *latin_face, la_px)
            shaping.draw(image, line, *latin_face, la_px,
                         ((width - wide) / 2, y), SUBDUED)
            y += la_step

    out.parent.mkdir(parents=True, exist_ok=True)
    image.save(out)
    return out


def build_segment(*, telugu: str, english: str, audio: Path, width: int, height: int,
                  out: Path, run_cmd, hold: float = 0.9) -> Path:
    """Still card plus the narrated moral, encoded to match the story's shots.

    `hold` keeps the card up a moment after the voice stops, so the film does not cut to
    black on the last syllable.
    """
    card = out.with_suffix(".png")
    render_card(telugu=telugu, english=english, width=width, height=height, out=card)

    duration = float(run_cmd([
        "ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1", str(audio),
    ])) + hold

    run_cmd([
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-loop", "1", "-framerate", "24", "-i", str(card),
        "-i", str(audio),
        "-filter_complex", f"[1:a]apad,atrim=0:{duration:.5f}[voice]",
        "-map", "0:v:0", "-map", "[voice]",
        "-c:v", "libx264", "-preset", "medium", "-crf", "19", "-pix_fmt", "yuv420p",
        "-r", "24", "-c:a", "aac", "-b:a", "192k",
        "-t", f"{duration:.5f}", "-movflags", "+faststart", str(out),
    ])
    return out
