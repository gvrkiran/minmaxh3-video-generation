"""Phase 3 gate: a deliberately bad script must be caught every time.

Each case injects one specific fault and asserts the validator names it. This is the
cheapest guard in the pipeline -- every fault here would otherwise cost 4.6 minutes of
GPU per shot and, in the name-leak case, produce a video with the wrong character in it.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
import h3_prompt  # noqa: E402

CPS, SOFT, HARD = 12.27, 124, 184

SUBJECTS = [
    {"name": "Vishnu Sharma", "description": "an elderly bald teacher in a white dhoti"},
    {"name": "The fox", "description": "a lean orange-red canid with a cream muzzle"},
]

GOOD_ACTION = (
    "A sunlit clearing. <Subject 1> stands beside a low rock while <Subject 2> approaches "
    "on all four legs, head tilted, tail sweeping once. Both stay fully in frame."
)


def build(**kw):
    args = dict(action=GOOD_ACTION, subjects=SUBJECTS, soundscape="soft breeze",
                music="light woodwind", telling_mode="silent")
    args.update(kw)
    return h3_prompt.build_prompt(**args)


CASES: list[tuple[str, object, str]] = []


def case(name: str, expect: str):
    def wrap(fn):
        CASES.append((name, fn, expect))
        return fn
    return wrap


@case("real name loose in the prompt", "outside a <d> tag")
def _name_leak():
    action = GOOD_ACTION.replace("<Subject 1>", "Vishnu Sharma", 1)
    p = build(action=action)
    return h3_prompt.validate_prompt(p, SUBJECTS, "silent")


@case("sections out of order", "out of order")
def _out_of_order():
    p = build()
    a, b = p.index("retention_analysis:"), p.index("detailed_description:")
    end = p.index("overall_soundscape:")
    p = p[:a] + p[b:end] + p[a:b] + p[end:]
    return h3_prompt.validate_prompt(p, SUBJECTS, "silent")


@case("summary missing [reference generation]", "[reference generation]")
def _no_ref_gen():
    return h3_prompt.validate_prompt(
        build().replace("[reference generation] ", ""), SUBJECTS, "silent")


@case("retention line reworded", "fully_preserved")
def _bad_retention():
    p = build().replace("<Subject 2> (appears in [Shot 1]): fully_preserved - ",
                        "<Subject 2> should be kept the same: ")
    return h3_prompt.validate_prompt(p, SUBJECTS, "silent")


@case("references an undefined subject", "undefined subjects")
def _undefined_subject():
    return h3_prompt.validate_prompt(
        build(action=GOOD_ACTION + " <Subject 3> watches from the trees."),
        SUBJECTS, "silent")


@case("a defined subject never used", "never used")
def _unused_subject():
    p = build(action="A sunlit clearing where <Subject 1> waits alone by the rock.")
    return h3_prompt.validate_prompt(p, SUBJECTS, "silent")


@case("picture index beyond the refs supplied", "only 2 refs")
def _bad_picture():
    return h3_prompt.validate_prompt(
        build(action=GOOD_ACTION + " The style follows <Picture 5>."), SUBJECTS, "silent")


@case("dialogue tag while telling_mode is silent", "silent but the prompt contains")
def _dialogue_in_silent():
    p = build(action=GOOD_ACTION + " <d>[Telugu] \u0c30\u0c3e.</d>")
    return h3_prompt.validate_prompt(p, SUBJECTS, "silent")


@case("dialogue tag missing its [Language] prefix", "missing its [Language]")
def _no_language_tag():
    p = build(action=GOOD_ACTION, telling_mode="dialogue",
              dialogue="<d>\u0c30\u0c3e \u0c2e\u0c3f\u0c24\u0c4d\u0c30\u0c2e\u0c3e.</d>")
    return h3_prompt.validate_prompt(p, SUBJECTS, "dialogue")


@case("straight quotes instead of a <d> tag", "straight quotation marks")
def _straight_quotes():
    return h3_prompt.validate_prompt(
        build(action=GOOD_ACTION + ' <Subject 2> says "hello" aloud.'), SUBJECTS, "silent")


@case("too many reference images", "exceeds the node limit")
def _too_many_refs():
    many = [{"name": f"Extra{i}", "description": f"a placeholder character {i}"}
            for i in range(10)]
    action = " ".join(f"<Subject {i + 1}> stands still." for i in range(10))
    return h3_prompt.validate_prompt(build(action=action, subjects=many), many, "silent")


# ---- narration cases ----

@case("narration over the 15-second ceiling", "over the 184-char ceiling")
def _too_long():
    long_te = "\u0c12\u0c15 \u0c30\u0c4b\u0c1c\u0c41 \u0c28\u0c15\u0c4d\u0c15 " * 20
    return h3_prompt.validate_narration(long_te, CPS, SOFT, HARD)


@case("Roman letters in the narration", "Roman letters")
def _roman():
    return h3_prompt.validate_narration(
        "\u0c12\u0c15 \u0c30\u0c4b\u0c1c\u0c41 fox \u0c35\u0c1a\u0c4d\u0c1a\u0c3f\u0c02\u0c26\u0c3f.",
        CPS, SOFT, HARD)


@case("digits in the narration", "contains digits")
def _digits():
    return h3_prompt.validate_narration(
        "\u0c2e\u0c42\u0c21\u0c41 3 \u0c26\u0c4b\u0c2c\u0c4d\u0c2c\u0c41\u0c32\u0c41.",
        CPS, SOFT, HARD)


@case("narration empty", "narration is empty")
def _empty():
    return h3_prompt.validate_narration("   ", CPS, SOFT, HARD)


@case("narration not in Telugu at all", "no Telugu characters")
def _no_telugu():
    return h3_prompt.validate_narration("!!! ... ???", CPS, SOFT, HARD)


def main() -> None:
    print("=== a clean prompt must produce no errors ===")
    clean = h3_prompt.validate_prompt(build(), SUBJECTS, "silent")
    clean += h3_prompt.validate_narration(
        "\u0c12\u0c15 \u0c30\u0c4b\u0c1c\u0c41 \u0c28\u0c15\u0c4d\u0c15 "
        "\u0c15\u0c4a\u0c02\u0c17\u0c28\u0c41 \u0c35\u0c3f\u0c02\u0c26\u0c41\u0c15\u0c41 "
        "\u0c2a\u0c3f\u0c32\u0c3f\u0c1a\u0c3f\u0c02\u0c26\u0c3f.", CPS, SOFT, HARD)
    if clean:
        print("  FALSE POSITIVES on a good prompt:")
        for e in clean:
            print(f"    - {e}")
    else:
        print("  clean: 0 errors")

    print(f"\n=== {len(CASES)} deliberate faults ===")
    failures = 0
    for name, fn, expect in CASES:
        errors = fn()
        caught = any(expect.lower() in e.lower() for e in errors)
        print(f"  [{'CAUGHT' if caught else 'MISSED':6s}] {name}")
        if not caught:
            failures += 1
            print(f"           expected to see {expect!r}; got: {errors}")
        elif len(errors) > 1:
            print(f"           (+{len(errors) - 1} other error(s) also reported)")

    frames_ok = all(h3_prompt.frames_for(s) % 17 == 5 for s in (1, 5, 10.125, 15, 40))
    bounded = (h3_prompt.frames_for(0.1) == 124 and h3_prompt.frames_for(99) == 362)
    print(f"\nframe grid on 17k+5 and clamped to 124-362: {frames_ok and bounded}")

    verdict = failures == 0 and not clean and frames_ok and bounded
    print(f"\n{'GATE PASSED' if verdict else f'GATE FAILED ({failures} missed)'}")
    sys.exit(0 if verdict else 1)


if __name__ == "__main__":
    main()
