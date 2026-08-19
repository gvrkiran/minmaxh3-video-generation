"""Draw Telugu correctly. Pillow on its own cannot.

Telugu needs OpenType shaping: consonant clusters reorder, vowel signs attach above and
below, and the rakar in a word like ప్రవర్తిస్తామో is a mark positioned with a *negative*
offset relative to its base. Pillow only does that when it is built against Raqm, and the
Windows wheel here reports `raqm: False` / `harfbuzz: False` -- so `draw.text` renders each
codepoint in logical order and the conjuncts come out malformed. It looks like Telugu at a
glance and is wrong to anyone who reads it.

So shaping goes through HarfBuzz (uharfbuzz) and rasterising through FreeType
(freetype-py), and the resulting glyph bitmaps are composited onto the Pillow image. For
the same string HarfBuzz turns 14 codepoints into 8 positioned glyphs, which is the whole
difference.

Latin text needs none of this, and falls back to Pillow when the shapers are missing.
"""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path

try:
    import freetype
    import uharfbuzz as hb
    SHAPING = True
except ImportError:                                   # pragma: no cover
    SHAPING = False


@lru_cache(maxsize=8)
def _hb_font(path: str, index: int, px: int):
    face = hb.Face(Path(path).read_bytes(), index)
    font = hb.Font(face)
    font.scale = (px * 64, px * 64)                   # positions come back in 26.6 fixed point
    hb.ot_font_set_funcs(font)
    return font


@lru_cache(maxsize=8)
def _ft_face(path: str, index: int, px: int):
    face = freetype.Face(path, index)
    face.set_char_size(px * 64)
    return face


def shape(text: str, path: str, index: int, px: int):
    """-> [(glyph_id, x_advance, x_offset, y_offset)] in pixels."""
    font = _hb_font(path, index, px)
    buf = hb.Buffer()
    buf.add_str(text)
    buf.guess_segment_properties()                    # detects Telu and ltr from the text
    hb.shape(font, buf)
    return [
        (info.codepoint, pos.x_advance / 64.0, pos.x_offset / 64.0, pos.y_offset / 64.0)
        for info, pos in zip(buf.glyph_infos, buf.glyph_positions)
    ]


def measure(text: str, path: str, index: int, px: int) -> float:
    if not SHAPING:
        return px * 0.5 * len(text)
    return sum(advance for _, advance, _, _ in shape(text, path, index, px))


def draw(image, text: str, path: str, index: int, px: int,
         origin: tuple[float, float], colour: tuple[int, int, int]) -> float:
    """Composite shaped glyphs. `origin` is the pen start on the baseline.

    Returns the advance width, so callers can centre a line by measuring first.
    """
    from PIL import Image

    face = _ft_face(path, index, px)
    pen_x, baseline = origin
    for gid, x_advance, x_offset, y_offset in shape(text, path, index, px):
        face.load_glyph(gid, freetype.FT_LOAD_RENDER)
        bitmap = face.glyph.bitmap
        if bitmap.width and bitmap.rows:
            # FreeType hands back an 8-bit alpha bitmap; use it as a mask for a solid fill.
            mask = Image.frombytes(
                "L", (bitmap.width, bitmap.rows),
                bytes(bitmap.buffer) if bitmap.pitch == bitmap.width
                else b"".join(bytes(bitmap.buffer[r * bitmap.pitch:
                                                 r * bitmap.pitch + bitmap.width])
                              for r in range(bitmap.rows)),
            )
            left = int(round(pen_x + x_offset + face.glyph.bitmap_left))
            top = int(round(baseline - y_offset - face.glyph.bitmap_top))
            image.paste(colour, (left, top), mask)
        pen_x += x_advance
    return pen_x - origin[0]


def wrap(text: str, path: str, index: int, px: int, max_width: float) -> list[str]:
    """Greedy wrap on whitespace, measured with the real shaped widths."""
    lines: list[str] = []
    current = ""
    for word in text.split():
        trial = f"{current} {word}".strip()
        if not current or measure(trial, path, index, px) <= max_width:
            current = trial
        else:
            lines.append(current)
            current = word
    if current:
        lines.append(current)
    return lines
