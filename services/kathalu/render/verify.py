"""Check a finished story: does every shot exist, is the Telugu actually on it, does the
join account for all of it, and is the picture continuous.

Written because "the file exists and plays" is a weak claim for a 90-second film assembled
from eight independent generations, five ffmpeg invocations and a concat.
"""
from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import Path


def probe(path: Path) -> dict:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-print_format", "json", "-show_streams", "-show_format",
         str(path)], capture_output=True, text=True, encoding="utf-8", errors="replace").stdout
    return json.loads(out or "{}")


def stream(info: dict, kind: str) -> dict:
    return next((s for s in info.get("streams", []) if s.get("codec_type") == kind), {})


def loudness(path: Path) -> float | None:
    """Mean volume in dBFS. Silence would mean the narration never made it onto the shot."""
    done = subprocess.run(
        ["ffmpeg", "-hide_banner", "-i", str(path), "-af", "volumedetect",
         "-f", "null", "-"], capture_output=True, text=True, encoding="utf-8", errors="replace")
    for line in (done.stderr or "").splitlines():
        if "mean_volume:" in line:
            return float(line.split("mean_volume:")[1].strip().split()[0])
    return None


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--story-dir", required=True)
    a = ap.parse_args()
    sd = Path(a.story_dir)

    script = json.loads((sd / "script.json").read_text(encoding="utf-8"))
    fit = json.loads((sd / "fit.json").read_text(encoding="utf-8"))
    narration = json.loads((sd / "narration.json").read_text(encoding="utf-8"))
    by_fit = {f["index"]: f for f in fit["scenes"]}
    by_narr = {n["index"]: n for n in narration["scenes"]}

    print(f"{'scene':>5} {'wanted':>7} {'shot':>7} {'narrated':>9} {'audio':>7} "
          f"{'dBFS':>7} {'size':>10}  checks")
    problems, sum_narrated = [], 0.0
    for scene in script["scenes"]:
        i = scene["index"]
        shot = sd / "shots" / f"scene_{i:02d}.mp4"
        narrated = sd / "narrated" / f"scene_{i:02d}.mp4"
        wanted = by_fit[i]["video_seconds"]
        audio_s = by_narr[i]["seconds"]

        if not shot.exists():
            problems.append(f"scene {i}: shot missing")
            continue
        if not narrated.exists():
            problems.append(f"scene {i}: narrated version missing")
            continue

        si, ni = probe(shot), probe(narrated)
        sv, nv, na = stream(si, "video"), stream(ni, "video"), stream(ni, "audio")
        sdur = float(si["format"]["duration"])
        ndur = float(ni["format"]["duration"])
        sum_narrated += ndur
        db = loudness(narrated)

        checks = []
        if abs(sdur - wanted) > 0.15:
            checks.append(f"shot {sdur:.2f}s != planned {wanted:.2f}s")
        if abs(ndur - sdur) > 0.15:
            checks.append("mux changed the duration")
        if not na:
            checks.append("NO AUDIO TRACK")
        elif db is not None and db < -45:
            checks.append(f"audio is effectively silent ({db:.1f} dBFS)")
        if audio_s > ndur + 0.05:
            checks.append(f"narration {audio_s:.2f}s longer than the shot -- it will be cut off")
        if (nv.get("width"), nv.get("height")) != (sv.get("width"), sv.get("height")):
            checks.append("mux changed the resolution")
        problems += [f"scene {i}: {c}" for c in checks]

        print(f"{i:>5} {wanted:>7.2f} {sdur:>7.2f} {ndur:>9.2f} {audio_s:>7.2f} "
              f"{(db if db is not None else float('nan')):>7.1f} "
              f"{nv.get('width')}x{nv.get('height'):<5}  {'; '.join(checks) or 'ok'}")

    # The closing moral card is a real segment of the film, so the join is longer than the
    # sum of the scenes by exactly its length. Counting it here stops a correct film from
    # being reported as broken.
    moral = sd / "narrated" / "zz_moral.mp4"
    if moral.exists():
        moral_s = float(probe(moral)["format"]["duration"])
        moral_db = loudness(moral)
        sum_narrated += moral_s
        print(f"{'moral':>5} {'':>7} {'':>7} {moral_s:>9.2f} {'':>7} "
              f"{(moral_db if moral_db is not None else float('nan')):>7.1f} "
              f"{'card':>10}  ok")
        if moral_db is not None and moral_db < -45:
            problems.append("the moral card has no audible narration")

    final = sd / "final.mp4"
    print()
    if not final.exists():
        problems.append("final.mp4 missing")
    else:
        fi = probe(final)
        fv, fa = stream(fi, "video"), stream(fi, "audio")
        fdur = float(fi["format"]["duration"])
        fdb = loudness(final)
        print(f"final.mp4  {fdur:.2f}s  {fv.get('width')}x{fv.get('height')}  "
              f"{fv.get('codec_name')}/{fa.get('codec_name')}  "
              f"{fv.get('nb_frames')} frames  {fdb:.1f} dBFS  "
              f"{final.stat().st_size / 1024 ** 2:.1f} MB")
        print(f"sum of narrated shots: {sum_narrated:.2f}s   "
              f"final: {fdur:.2f}s   difference: {abs(fdur - sum_narrated):.2f}s")
        if abs(fdur - sum_narrated) > 0.4:
            problems.append(f"final duration is {abs(fdur - sum_narrated):.2f}s off the sum "
                            "of its parts -- a shot may be missing from the join")
        if not fa:
            problems.append("final.mp4 has no audio track")
        elif fdb is not None and fdb < -45:
            problems.append("final.mp4 audio is effectively silent")

    print()
    if problems:
        print(f"{len(problems)} PROBLEM(S):")
        for p in problems:
            print(f"  - {p}")
    else:
        print("all checks passed")
    raise SystemExit(1 if problems else 0)


if __name__ == "__main__":
    main()
