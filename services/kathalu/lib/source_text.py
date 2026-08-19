"""Which text each stage should reason over when the book was not in English.

Her first storybook was Telugu, not English. It went through -- the vision pass read the
page, the cast came out right, a Telugu moral was composed -- but only because every stage
was quietly translating inside its own prompt. Nothing on disk was the English text, so the
cast stage and the script stage each translated independently and could drift: one calls a
character the village youths, the other the young men of the village, and they no longer
refer to the same subject.

So the cleanup stage now writes one English translation, and everything downstream reads it
from here. Two rules, and they pull in opposite directions:

  * English is the authority for anything the machines consume -- character appearance for
    the image model, shot action for the video model, her English review summaries. Those
    models are trained on English and nothing else.

  * The printed original is the authority for the NARRATION wording. Translating Telugu to
    English and back would give her voice track the register of a translation instead of the
    register of her book. The narration should sound like the page she photographed.
"""


def english_story(story: dict) -> str:
    """The story in English, whatever language the page was printed in."""
    return (story.get("story_english") or "").strip() or story.get("story_text", "")


def english_title(story: dict) -> str:
    return (story.get("title_english") or "").strip() or story.get("title", "")


def english_moral(story: dict) -> str:
    return (story.get("moral_english") or "").strip() or story.get("moral", "")


def as_printed(story: dict) -> dict | None:
    """The original text, only when it is not English -- otherwise None.

    Callers pass this alongside the English so the narration can follow the book's own
    words. `None` keeps it out of the prompt entirely for English sources, which are the
    common case and need no second copy.
    """
    language = (story.get("language") or "").strip()
    if not (story.get("story_english") or "").strip():
        return None
    if language.lower() in ("", "english"):
        return None
    return {
        "language": language,
        "title": story.get("title", ""),
        "moral": story.get("moral", ""),
        "story_text": story.get("story_text", ""),
    }
