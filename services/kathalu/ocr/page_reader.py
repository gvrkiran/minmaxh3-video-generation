"""Kathalu Studio -- local page reader.

Runs in its own venv (H:\\KathaluStudio\\ocr-venv) because rapidocr wants numpy 2.x
while IndicF5's f5-tts pins numpy<=1.26.4. CPU only, so it never competes with H3
or Qwen for the 24 GB.

Two jobs:
  1. Read the text off a phone photo of a curved book page.
  2. Report where the photograph itself ran out, so that missing text is flagged for
     a retake rather than quietly invented downstream.

Three things were learned the hard way getting recall up on these photos:

  * Page-quad detection is useless here -- the patterned fabric is as bright as the
    paper, so brightness segmentation grabs the whole frame.
  * The pages are *curved*, not merely tilted. On story1_1 the top two body lines sit
    at roughly -9 deg while the lines below them are near level, so no single global
    rotation levels both, and at the wrong angle the detector either merges four lines
    into one box or misses them entirely. Hence several angle passes, merged.
  * Detector resolution was not the problem -- recall was identical from
    det_limit_side_len 736 through 2560.

Geometry can say a line reaches the edge of the photo. It cannot say whether words are
missing there; that is a question about language, answered downstream with the image in
hand. So nothing here is called "clipped".

Usage:  python page_reader.py <image> [...] --out result.json [--debug]
"""
from __future__ import annotations

import argparse
import json
import os
import re
from pathlib import Path

import cv2
import numpy as np
from rapidocr_onnxruntime import RapidOCR

# Data, not source: debug overlays live with the other generated artefacts.
DEBUG_ROOT = os.environ.get("KATHALU_DEBUG_ROOT", r"H:\KathaluStudio\debug")
EDGE_FRAC = 0.010          # "reaches the border", as a fraction of the short side
MIN_CONF = 0.45
PASS1_LONG_EDGE = 1400     # angle estimation only needs enough to find baselines
SWEEP = (0.0,)             # a single pass at the estimated angle.
# A -9/-4.5/0/+4.5 sweep was tried to catch the curved top lines and made things
# worse (story2_2 15->9 lines, story4_1 13->8): mapping a tilted quad back to source
# coordinates inflates its axis-aligned bbox vertically, so neighbouring lines look
# like duplicates and get merged away. Left here as a marker -- the residual gap is
# a handful of steeply-curved lines, which the vision reconciliation step recovers.
MERGED_BOX_FACTOR = 2.6    # boxes taller than this * median line height are line-merges

_engine: RapidOCR | None = None


def engine() -> RapidOCR:
    """unclip_ratio below the 1.6 default: these lines are tightly leaded and the
    default dilation fuses neighbouring lines into one box."""
    global _engine
    if _engine is None:
        _engine = RapidOCR(det_db_unclip_ratio=1.35, det_db_box_thresh=0.35, text_score=0.35)
    return _engine


def enhance(bgr: np.ndarray) -> np.ndarray:
    """Flatten the lighting, then boost local contrast. These photos carry a shadow
    across the gutter and a bright hotspot near the spine."""
    lab = cv2.cvtColor(bgr, cv2.COLOR_BGR2LAB)
    light = lab[:, :, 0].astype(np.float32)
    k = max(31, (min(bgr.shape[:2]) // 8) | 1)
    field = cv2.GaussianBlur(light, (k, k), 0)
    flat = np.clip(light / np.maximum(field, 1e-3) * float(np.mean(field)), 0, 255)
    lab[:, :, 0] = cv2.createCLAHE(clipLimit=2.4, tileGridSize=(8, 8)).apply(flat.astype(np.uint8))
    return cv2.cvtColor(lab, cv2.COLOR_LAB2BGR)


def _quad(box) -> np.ndarray:
    return np.asarray(box, dtype=np.float32).reshape(4, 2)


def base_angle(bgr: np.ndarray) -> float:
    """Width-weighted median baseline angle; the centre of the sweep."""
    s = min(1.0, PASS1_LONG_EDGE / max(bgr.shape[:2]))
    small = cv2.resize(bgr, None, fx=s, fy=s, interpolation=cv2.INTER_AREA) if s < 1 else bgr
    result, _ = engine()(small)
    angles, weights = [], []
    for box, _t, score in (result or []):
        if float(score) < MIN_CONF:
            continue
        tl, tr, br, bl = _quad(box)
        for a, b in ((tl, tr), (bl, br)):
            d = b - a
            width = float(np.hypot(*d))
            if width >= 25:
                ang = float(np.degrees(np.arctan2(d[1], d[0])))
                if abs(ang) <= 45:
                    angles.append(ang)
                    weights.append(width)
    if not angles:
        return 0.0
    order = np.argsort(angles)
    cum = np.cumsum(np.asarray(weights)[order])
    return float(np.asarray(angles)[order][int(np.searchsorted(cum, cum[-1] / 2.0))])


def _rotation(bgr: np.ndarray, degrees: float) -> tuple[np.ndarray, np.ndarray]:
    h, w = bgr.shape[:2]
    m = cv2.getRotationMatrix2D((w / 2.0, h / 2.0), degrees, 1.0)
    cos, sin = abs(m[0, 0]), abs(m[0, 1])
    nw, nh = int(h * sin + w * cos), int(h * cos + w * sin)
    m[0, 2] += nw / 2.0 - w / 2.0
    m[1, 2] += nh / 2.0 - h / 2.0
    out = cv2.warpAffine(bgr, m, (nw, nh), flags=cv2.INTER_CUBIC,
                         borderMode=cv2.BORDER_CONSTANT, borderValue=(255, 255, 255))
    return out, m


def _norm(text: str) -> str:
    return re.sub(r"[^a-z0-9]", "", text.lower())


def _overlap(a: dict, b: dict, h_med: float) -> bool:
    """Same physical line of print, found by two different angle passes?"""
    ax0, ay0, ax1, ay1 = a["bbox"]
    bx0, by0, bx1, by1 = b["bbox"]
    if abs((ay0 + ay1) / 2 - (by0 + by1) / 2) > 0.6 * h_med:
        return False
    inter = max(0.0, min(ax1, bx1) - max(ax0, bx0))
    return inter > 0.4 * min(ax1 - ax0, bx1 - bx0)


def collect(bgr: np.ndarray) -> list[dict]:
    """OCR at several angles, map every detection back to source coordinates, merge."""
    centre = base_angle(bgr)
    found: list[dict] = []
    for delta in SWEEP:
        work, m = _rotation(bgr, centre + delta)
        result, _ = engine()(work)
        inv = cv2.invertAffineTransform(m)
        for box, text, score in (result or []):
            if float(score) < MIN_CONF or not str(text).strip():
                continue
            pts = cv2.transform(_quad(box).reshape(1, 4, 2), inv).reshape(4, 2)
            found.append({
                "text": str(text).strip(),
                "confidence": round(float(score), 3),
                "bbox": [float(pts[:, 0].min()), float(pts[:, 1].min()),
                         float(pts[:, 0].max()), float(pts[:, 1].max())],
                "angle": round(centre + delta, 2),
            })
    if not found or len(SWEEP) == 1:
        # Single pass produces no duplicates, and both the merged-box filter and the
        # overlap dedupe *cost* recall here: a tilted quad mapped back to source
        # coordinates has an inflated axis-aligned bbox, which trips both tests against
        # innocent neighbouring lines. Measured: applying them dropped story4_1 from
        # 13 lines to 7. So they run only when there is actually something to merge.
        return found

    heights = np.array([d["bbox"][3] - d["bbox"][1] for d in found])
    h_med = float(np.median(heights))
    found = [d for d in found if (d["bbox"][3] - d["bbox"][1]) <= MERGED_BOX_FACTOR * h_med]

    # Prefer the longest confident reading of each physical line.
    found.sort(key=lambda d: -(d["confidence"] * (len(_norm(d["text"])) ** 0.5)))
    kept: list[dict] = []
    for cand in found:
        if not any(_overlap(cand, k, h_med) for k in kept):
            kept.append(cand)
    return kept


def read_page(path: Path, debug_dir: Path | None = None) -> dict:
    bgr = cv2.imread(str(path))
    if bgr is None:
        return {"file": path.name, "error": "unreadable image"}

    boosted = enhance(bgr)
    lines = collect(boosted)

    h, w = bgr.shape[:2]
    tol = EDGE_FRAC * min(h, w)
    for ln in lines:
        x0, y0, x1, y1 = ln["bbox"]
        at = []
        if x0 <= tol:
            at.append("left")
        if x1 >= w - 1 - tol:
            at.append("right")
        if y0 <= tol:
            at.append("top")
        if y1 >= h - 1 - tol:
            at.append("bottom")
        ln["at_photo_edge"] = at
        ln["bbox"] = [round(v, 1) for v in ln["bbox"]]

    # reading order: group into rows by vertical overlap, then left to right
    lines.sort(key=lambda ln: ln["bbox"][1])
    rows: list[list[dict]] = []
    for ln in lines:
        lh = ln["bbox"][3] - ln["bbox"][1]
        if rows and ln["bbox"][1] < rows[-1][-1]["bbox"][3] - 0.5 * lh:
            rows[-1].append(ln)
        else:
            rows.append([ln])
    ordered = [ln for row in rows for ln in sorted(row, key=lambda l: l["bbox"][0])]

    # One line near the margin is ordinary. Many lines terminating against the same
    # boundary is what a cut-off page looks like.
    pileup = {s: sum(1 for ln in ordered if s in ln["at_photo_edge"])
              for s in ("left", "right", "top", "bottom")}
    pileup = {s: n for s, n in pileup.items() if n}
    suspect = sorted(s for s, n in pileup.items()
                     if n >= 3 and n >= 0.4 * max(1, len(ordered)))

    if debug_dir:
        debug_dir.mkdir(parents=True, exist_ok=True)
        vis = bgr.copy()
        for ln in ordered:
            x0, y0, x1, y1 = (int(v) for v in ln["bbox"])
            hot = bool(set(ln["at_photo_edge"]) & set(suspect))
            cv2.rectangle(vis, (x0, y0), (x1, y1), (0, 0, 235) if hot else (0, 175, 0), 3)
        cv2.imwrite(str(debug_dir / f"{path.stem}_ocr.jpg"), vis,
                    [int(cv2.IMWRITE_JPEG_QUALITY), 80])

    conf = float(np.mean([ln["confidence"] for ln in ordered])) if ordered else 0.0
    return {
        "file": path.name,
        "photo_size": [w, h],
        "line_count": len(ordered),
        "mean_confidence": round(conf, 3),
        "edge_pileup": pileup,
        "suspect_sides": suspect,
        "raw_text": "\n".join(ln["text"] for ln in ordered),
        "lines": ordered,
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("images", nargs="+")
    ap.add_argument("--out", default="ocr-result.json")
    ap.add_argument("--debug", action="store_true")
    a = ap.parse_args()

    dbg = Path(DEBUG_ROOT) if a.debug else None
    pages = []
    for raw in a.images:
        p = Path(raw)
        r = read_page(p, dbg)
        pages.append(r)
        pile = ",".join(f"{s}:{n}" for s, n in (r.get("edge_pileup") or {}).items())
        print(f"{p.name:22s} lines={r.get('line_count', 0):3d} "
              f"conf={r.get('mean_confidence', 0):.3f} pileup={pile or '-':22s} "
              f"suspect={','.join(r.get('suspect_sides') or []) or '-'}", flush=True)

    Path(a.out).write_text(json.dumps({"pages": pages}, ensure_ascii=False, indent=2),
                           encoding="utf-8")     # cp1252 cannot encode Telugu
    print(f"\nwrote {a.out}")


if __name__ == "__main__":
    main()
