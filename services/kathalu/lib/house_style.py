"""The house look every film is made in.

Kathalu Studio used to derive its look from the book it was reading: `character_extract.py`
asked the LLM to describe the illustration style on her pages, and that paragraph was
prepended to every portrait prompt. Kiran asked for a single house style instead, matched to
a reference set of 3D-animated frames, so the look no longer varies book to book.

It takes TWO strings, not one, because a shot's picture is assembled from two places that
never meet:

  * CAST_STYLE goes into the character portraits, and the video inherits it -- H3 is told
    the reference picture is the sole source of a subject's visual style and is forbidden to
    restyle it. This is the lever that decides 3D-vs-flat, and it does most of the work:
    swapping the style-anchor image from a reference frame to one of her flat book pages
    changed the result only from matte to slightly glossier, not from 3D to flat.
  * SCENE_LOOK goes into every shot's prompt. Nothing about camera, lens, depth of field,
    background or light travels from the portraits, so it has to be said here or it does not
    happen.

CAST_STYLE deliberately says nothing about scenery, camera or dramatic lighting. Portraits
are reference sheets on flat grey and FRAMING in build_cast.py asks for even frontal light;
a paragraph asking for volumetric god rays fights that and trips the background-plainness
retry, burning three GPU attempts per character.

STYLE_ID is stamped on every portrait record. The character library is shared across
stories and reused by key, so without a stamp a fox drawn under the old book-derived style
would be silently reused in a film made under this one, and would be the only flat
character in it. build_cast.py treats a mismatched stamp as a redraw.
"""
from __future__ import annotations

STYLE_ID = "cgi-3d-v1"

CAST_STYLE = (
    "Render in modern 3D computer-animated feature style: full physically-based shading "
    "with soft ray-traced shadows and gentle global illumination -- not a drawing, not flat "
    "cel shading, not a painting. Bodies of insects and animals are hard semi-glossy shells "
    "with a faint clear-coat sheen and small tight specular highlights along every segment, "
    "joint and leg; fur is groomed as individual visible strands with soft fly-away hairs "
    "breaking the silhouette; shells and skin carry fine surface detail such as pores, faint "
    "scuffs and a few beaded water droplets. Proportions are cartoon-exaggerated over true "
    "anatomy: the head is oversized, roughly a third of the body length, carried on a slim "
    "neck, while limb count and body segmentation stay anatomically correct for the species. "
    "The eyes dominate the face -- very large, spherical and glossy, with clean white "
    "sclera, a wide round black pupil ringed by a warm amber-brown iris, one hard white "
    "catchlight, a soft eyelid crease above, and thin dark expressive eyebrow ridges that "
    "carry the whole emotion. Mouths are humanlike and mobile, with lips, small teeth and a "
    "tongue visible when open. Hands and forepaws are small, soft and five-fingered, able to "
    "gesture and hold things. Colour is warm and moderately saturated -- terracotta and "
    "reddish-brown, warm tan and cream, deep forest green -- never neon, never pastel, and "
    "shadows stay warm grey rather than black. Every surface reads as expensive studio CGI: "
    "clean, smooth, faintly toy-glossy, crisply defined at the edges, with no outlines, no "
    "brush strokes and no paper texture."
)

SCENE_LOOK = (
    "Shot as modern 3D animated feature cinematography: the camera sits low at the "
    "characters' own eye level, close on them with a wide lens so their heads fill much of "
    "the frame; the background recedes through three hazy depth planes and falls out of "
    "focus into soft round bokeh; a strong soft key light rakes in from high behind, tracing "
    "a bright warm rim along heads, hair and fur, with visible shafts of volumetric light "
    "and slow floating dust motes; surfaces carry fine detail and a little moisture; soft "
    "ray-traced shadows, shallow depth of field, and a slow gentle camera push in."
)
