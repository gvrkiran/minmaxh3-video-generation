"""Kathalu Studio -- draw the cast and keep it.

For each extracted character: compose a portrait prompt (the book's style paragraph +
that character's appearance + fixed reference-sheet framing), generate it locally with
Qwen-Image-Edit-2511 using one of her own book pages as the style anchor, and file it in
a library keyed by character so the next video reuses the same fox.

Portraits are shaped for what H3's reference pipeline wants, which is not the same as a
pretty illustration: one character alone, whole body, neutral pose, plain ground, nothing
occluding it. Measured in phase 0 at 18.2 s each with the 4-step Lightning LoRA -- 4 steps
and 8 steps were visually indistinguishable.

The library record matches the CharacterProfile shape the existing studio already reads
(id, name, description, filename, mimeType, createdAt) and adds the fields the story
pipeline needs, so both tools can share it.

Usage:
  python build_cast.py --cast cast3.json --style-ref story3_1.jpeg
  python build_cast.py --cast cast3.json --style-ref story3_1.jpeg --only "The fox" \\
      --note "make his tail bushier"
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "llm"))
import comfy_client as comfy  # noqa: E402
from gpu_lock import GpuLock  # noqa: E402

LIBRARY = Path(r"H:\KathaluStudio\characters")
UNET_GGUF = "qwen-image-edit-2511-Q6_K.gguf"
CLIP_NAME = "qwen\\qwen_2.5_vl_7b_fp8_scaled.safetensors"
VAE_NAME = "qwen_image_vae.safetensors"
LORA_4STEP = "Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors"
STEPS = 4

# Quadrupeds read better wide; bipeds and wading birds read better tall.
WIDE_SPECIES = {"fox", "goat", "lion", "donkey", "jackal", "dog", "cow", "bull",
                "tiger", "elephant", "cat", "mouse", "rat", "deer", "camel", "horse",
                "monkey", "bear", "wolf", "pig", "buffalo", "calf"}

FRAMING = (
    "Character reference sheet showing this one character only: a single individual, alone "
    "in the frame, not a pair and not a group. The whole body is visible with clear space "
    "around it -- nothing cropped, nothing cut off at any edge. Isolated on a plain flat "
    "pale neutral grey background: no scenery, no ground plane, no shadow cast on a floor, "
    "no border, no frame, no text, no labels. Even soft frontal lighting."
)

# NOTE: Lightning is a distilled LoRA and requires cfg=1.0, which means there is no
# classifier-free guidance and this negative conditioning has NO effect. It is wired up
# because the graph shape expects it, but every real constraint has to be stated
# positively in FRAMING and in the appearance text. Learned by asking for "no duplicate
# characters" here and getting two goats anyway.
NEGATIVE = (
    "photorealistic, photograph, realistic skin texture, text, letters, caption, watermark, "
    "signature, book page, page layout, multiple characters, duplicate, twins, crowd, "
    "cropped, cut off, out of frame, close-up, background scenery, landscape, furniture, "
    "harsh shadows, dark, blurry, low detail, extra limbs, deformed, mutated"
)


def slug(text: str) -> str:
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-", text.lower())).strip("-")


def character_key(character: dict) -> str:
    """Stable identity across stories: the same fox resolves to the same library entry."""
    return f"{slug(character['name'])}--{slug(character['species'])}"


def character_id(key: str) -> str:
    """Deterministic id, shaped to satisfy the existing studio's safeId() regex."""
    h = hashlib.sha256(key.encode()).hexdigest()
    return f"{h[:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:32]}"


def resolution(character: dict) -> tuple[int, int]:
    wide = character.get("species", "").lower() in WIDE_SPECIES
    return (1152, 768) if wide else (768, 1152)


def portrait_prompt(character: dict, style_paragraph: str) -> str:
    """Note that there is no `note` parameter. A tweak is merged into `appearance`
    upstream by revise_appearance(); appending it here left the original and the
    requested colours both standing in the prompt, and Qwen drew two animals."""
    subject = "creature" if character.get("kind") == "animal" else "person"
    return " ".join([
        f"A full-body character reference of exactly one {character['species']} {subject}, "
        "and no other creature or person anywhere in the image.",
        character["appearance"].rstrip(". ") + ".",
        character["portrait_pose"].rstrip(". ") + ".",
        "Match the illustration style of the reference image exactly. " + style_paragraph,
        FRAMING,
    ])


def build_graph(*, prompt: str, style_ref: str, width: int, height: int,
                seed: int, prefix: str) -> dict:
    return {
        "1": {"inputs": {"unet_name": UNET_GGUF},
              "class_type": "UnetLoaderGGUF", "_meta": {"title": "Qwen Edit 2511 Q6_K"}},
        "2": {"inputs": {"clip_name": CLIP_NAME, "type": "qwen_image", "device": "default"},
              "class_type": "CLIPLoader", "_meta": {"title": "Qwen2.5-VL"}},
        "3": {"inputs": {"vae_name": VAE_NAME},
              "class_type": "VAELoader", "_meta": {"title": "Qwen VAE"}},
        "4": {"inputs": {"model": ["1", 0], "lora_name": LORA_4STEP, "strength_model": 1.0},
              "class_type": "LoraLoaderModelOnly", "_meta": {"title": "Lightning 4-step"}},
        "5": {"inputs": {"model": ["4", 0], "shift": 3.1},
              "class_type": "ModelSamplingAuraFlow", "_meta": {"title": "Sigma shift"}},
        "6": {"inputs": {"image": style_ref},
              "class_type": "LoadImage", "_meta": {"title": "Style anchor (her book page)"}},
        "7": {"inputs": {"clip": ["2", 0], "prompt": prompt, "vae": ["3", 0],
                         "image1": ["6", 0]},
              "class_type": "TextEncodeQwenImageEditPlus", "_meta": {"title": "Positive"}},
        "8": {"inputs": {"clip": ["2", 0], "prompt": NEGATIVE, "vae": ["3", 0]},
              "class_type": "TextEncodeQwenImageEditPlus", "_meta": {"title": "Negative"}},
        "9": {"inputs": {"width": width, "height": height, "batch_size": 1},
              "class_type": "EmptySD3LatentImage", "_meta": {"title": "Canvas"}},
        "10": {"inputs": {"model": ["5", 0], "seed": seed, "steps": STEPS, "cfg": 1.0,
                          "sampler_name": "euler", "scheduler": "simple",
                          "positive": ["7", 0], "negative": ["8", 0],
                          "latent_image": ["9", 0], "denoise": 1.0},
               "class_type": "KSampler", "_meta": {"title": "Sample"}},
        "11": {"inputs": {"samples": ["10", 0], "vae": ["3", 0]},
               "class_type": "VAEDecode", "_meta": {"title": "Decode"}},
        "12": {"inputs": {"images": ["11", 0], "filename_prefix": f"kathalu-cast/{prefix}"},
               "class_type": "SaveImage", "_meta": {"title": "Save"}},
    }


def finalize(src: Path, dst: Path) -> dict:
    """File the portrait unchanged and measure it. Deliberately does NOT retouch.

    An earlier version flattened the background: masked the subject by colour distance,
    cleaned the mask morphologically, kept the largest connected component, and repainted
    the rest flat. On a white stork against a pale grey ground that decapitated the bird --
    the neck gave a marginal mask, MORPH_OPEN fragmented it, and "keep the largest
    component" then discarded the head, neck and one shoulder. Qwen's raw output was
    already a clean, plainly-backed reference image; the step was solving a problem that
    did not exist and destroying subjects to do it.

    So this measures instead: is the background actually plain, and is the whole subject
    inside the frame? Both matter to H3, and a warning is cheap where a bad edit is not.
    """
    import cv2
    import numpy as np

    shutil.copyfile(src, dst)
    img = cv2.imread(str(dst))
    if img is None:
        return {"measured": False}

    h, w = img.shape[:2]
    band_h, band_w = max(2, h // 40), max(2, w // 40)
    border = np.concatenate([
        img[:band_h, :, :].reshape(-1, 3), img[-band_h:, :, :].reshape(-1, 3),
        img[:, :band_w, :].reshape(-1, 3), img[:, -band_w:, :].reshape(-1, 3),
    ]).astype(np.float32)
    bg = np.median(border, axis=0)
    bg_spread = float(np.mean(np.std(border, axis=0)))

    dist = np.linalg.norm(img.astype(np.float32) - bg[None, None, :], axis=2)
    mask = dist > 24
    ys, xs = np.nonzero(mask)
    if len(xs) == 0:
        return {"measured": True, "subject_area": 0.0, "empty": True}

    x0, x1, y0, y1 = int(xs.min()), int(xs.max()), int(ys.min()), int(ys.max())
    margin = max(2, min(h, w) // 100)
    touching = [side for side, hit in (
        ("left", x0 <= margin), ("right", x1 >= w - 1 - margin),
        ("top", y0 <= margin), ("bottom", y1 >= h - 1 - margin)) if hit]

    return {
        "measured": True,
        "subject_area": round(float(mask.mean()), 3),
        "subject_bbox": [x0, y0, x1, y1],
        "background_rgb": [int(v) for v in bg[::-1]],
        "background_plain": bool(bg_spread < 4.0),
        "background_spread": round(bg_spread, 1),
        # H3 wants clear space around the subject; touching an edge risks a cropped read.
        "touches_frame": touching,
    }


def load_library() -> dict:
    LIBRARY.mkdir(parents=True, exist_ok=True)
    out = {}
    for js in LIBRARY.glob("*.json"):
        try:
            rec = json.loads(js.read_text(encoding="utf-8"))
            out[rec["characterKey"]] = rec
        except (json.JSONDecodeError, KeyError, OSError):
            continue
    return out


def make_portrait(character: dict, style_paragraph: str, style_ref_name: str,
                  note: str = "", seed: int | None = None, reseed: bool = False) -> dict:
    key = character_key(character)
    cid = character_id(key)
    width, height = resolution(character)

    revision = None
    if note:
        from character_extract import revise_appearance
        revision = revise_appearance(character["appearance"], note)
        character = {**character, "appearance": revision["appearance"]}
        print(f"      revised: {revision['changed']}")

    prompt = portrait_prompt(character, style_paragraph)
    if seed is None:
        # Deterministic by default, so an unchanged character redraws identically and the
        # library stays stable across stories. But "Try again" with no note would then
        # regenerate a byte-identical image -- which is exactly what "nothing happens"
        # looked like in the UI -- so an explicit retry asks for a fresh seed.
        basis = key + note
        if reseed:
            basis += f"|{time.time_ns()}"
        seed = int(hashlib.sha256(basis.encode()).hexdigest()[:8], 16) % 2_000_000_000

    # A portrait that comes back with scenery is unusable as an R2V reference -- H3 reads
    # the landscape as part of the subject. At cfg=1.0 the negative prompt cannot forbid it
    # (Lightning is distilled, so there is no classifier-free guidance), and a reseeded
    # redraw sometimes borrows the style anchor's sky and trees. Measured: a clean portrait
    # has a border colour spread near 0.6, one with scenery measured 13.1. So retry.
    LIBRARY.mkdir(parents=True, exist_ok=True)
    final = LIBRARY / f"{cid}.png"
    attempts = []
    for attempt in range(1, 4):
        result = comfy.run(
            build_graph(prompt=prompt, style_ref=style_ref_name, width=width, height=height,
                        seed=seed, prefix=slug(character["name"])),
            label=f"{character['name']} ({width}x{height})"
                  + (f" retry {attempt}" if attempt > 1 else ""),
        )
        produced = comfy.output_path(result["files"][0])
        stats = finalize(produced, final)
        attempts.append((stats.get("background_spread", 999), produced, dict(stats)))
        if stats.get("background_plain"):
            break
        print(f"      background not plain (spread "
              f"{stats.get('background_spread')}); reseeding")
        seed = int(hashlib.sha256(f"{seed}|{time.time_ns()}".encode()).hexdigest()[:8], 16) % 2_000_000_000
    else:
        # All three had scenery: keep the plainest rather than the last.
        best = min(attempts, key=lambda a: a[0])
        produced, stats = best[1], best[2]
        finalize(produced, final)
        print(f"      kept the plainest of 3 (spread {best[0]})")

    record = {
        # fields the existing studio's CharacterProfile reads
        "id": cid,
        "name": character["name"],
        "description": character["appearance"],
        "filename": final.name,
        "mimeType": "image/png",
        "createdAt": int(time.time() * 1000),
        # fields the story pipeline needs
        "characterKey": key,
        "kind": character["kind"],
        "species": character["species"],
        "gender": character["gender"],
        "role": character["role"],
        "count": character.get("count", 1),
        "portraitPose": character["portrait_pose"],
        "proper_names": character.get("proper_names") or [],
        "prompt": prompt,
        "seed": seed,
        "note": note,
        "revision": revision,
        "width": width,
        "height": height,
        "seconds": result["seconds"],
        "rawOutput": str(produced),
        "quality": stats,
    }
    (LIBRARY / f"{cid}.json").write_text(
        json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
    return record


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cast", required=True)
    ap.add_argument("--style-ref", required=True, help="one of her book page photos")
    ap.add_argument("--only", help="regenerate just this character by name")
    ap.add_argument("--note", default="", help="free-text adjustment, e.g. 'make her sari green'")
    ap.add_argument("--reseed", action="store_true",
                    help="force a different seed -- what 'Try again' needs")
    ap.add_argument("--reuse", action="store_true",
                    help="skip characters already in the library")
    a = ap.parse_args()

    cast = json.loads(Path(a.cast).read_text(encoding="utf-8"))
    style_ref = comfy.upload_image(a.style_ref, f"kathalu_style_{Path(a.style_ref).name}")
    print(f"style anchor: {style_ref}")

    library = load_library()
    wanted = cast["characters"]
    if a.only:
        # Match either the display name or the stable character key. The UI holds keys;
        # a person typing on the command line holds names. Accepting only names meant every
        # redraw from the web UI failed with "no character named 'the-lion--lion'".
        needle = a.only.strip().lower()
        wanted = [c for c in wanted
                  if c["name"].strip().lower() == needle or character_key(c) == needle]
        if not wanted:
            known = ", ".join(f'{c["name"]!r}/{character_key(c)}' for c in cast["characters"])
            raise SystemExit(f"no character matching {a.only!r} in {a.cast}. known: {known}")

    # Work out first whether anything actually needs the GPU. A cast that is entirely
    # reused from the library draws nothing, and must not queue behind a 40-minute render
    # for no reason.
    todo = [c for c in wanted
            if not (a.reuse and character_key(c) in library and not a.note)]
    for character in wanted:
        key = character_key(character)
        if a.reuse and key in library and not a.note:
            rec = library[key]
            print(f"  {character['name']:<24s} reused from library ({rec['filename']})")

    if todo:
        # One GPU, one job. The portraits go through ComfyUI, which queues graphs serially,
        # but the render stage loads its voice model outside ComfyUI altogether -- so
        # without this a story drawing portraits can land on the card at the same moment
        # another is narrating, and 24 GB does not hold both.
        story_name = cast.get("title") or Path(a.cast).parent.name
        with GpuLock("drawing the characters", story=story_name):
            print()
            print(f"drawing {len(todo)} character(s):")
            for character in todo:
                rec = make_portrait(character, cast["style_paragraph"], style_ref, a.note,
                                    reseed=a.reseed)
                print(f"      -> {rec['filename']}  seed={rec['seed']}  "
                      f"subject_area={rec['quality'].get('subject_area')}")
    print(f"\nlibrary now holds {len(load_library())} character(s) in {LIBRARY}")


if __name__ == "__main__":
    main()
