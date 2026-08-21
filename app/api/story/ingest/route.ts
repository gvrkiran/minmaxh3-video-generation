/** Screen 2 -> 3: take the pages in, read them, hand back a complete story. */
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  MODULE_PATHS, STORIES_ROOT, exists, readJson, runPython, storySlug, fail,
} from "@/lib/story-runner";

export const dynamic = "force-dynamic";

const FALLBACK_STYLE_PAGE = path.join(
  "C:", "Users", "kg766", "Box", "tmp_share", "story_generation_project", "story3_1.jpeg",
);

/**
 * A pasted paragraph has no title line, and taking the first line whole gave both a
 * nonsense title and a 60-character folder name. Use a short opening line as a title if
 * it looks like one; otherwise take the first few words. She can correct it next screen.
 */
function guessTitle(text: string): string {
  const first = text.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
  const looksLikeATitle = first.length <= 70 && !/[.!?]$/.test(first);
  if (looksLikeATitle && first) return first;
  const words = first.replace(/[.!?].*$/, "").split(/\s+/).filter(Boolean).slice(0, 7);
  return words.length ? words.join(" ") : "My story";
}

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const typed = String(form.get("text") ?? "").trim();
    const photos = form.getAll("photos").filter((f): f is File => f instanceof File);
    if (!typed && photos.length === 0) {
      return Response.json({ error: "Add a story, or some photos of the pages." }, { status: 400 });
    }

    const scratch = path.join(STORIES_ROOT, `_incoming-${Date.now()}`);
    await fs.mkdir(path.join(scratch, "pages"), { recursive: true });

    let story: Record<string, unknown> | null;
    if (photos.length) {
      // Page order is the one thing we cannot infer, so it is fixed by the order she gave.
      const saved: string[] = [];
      for (const [index, photo] of photos.entries()) {
        const name = `page_${String(index + 1).padStart(2, "0")}${path.extname(photo.name) || ".jpg"}`;
        const target = path.join(scratch, "pages", name);
        await fs.writeFile(target, Buffer.from(await photo.arrayBuffer()));
        saved.push(target);
      }
      // The model reads the pages itself. There used to be a local OCR pass here; it could
      // not represent Telugu at all and it scrambled two-column pages, so its transcript
      // was actively misleading the reader that followed it.
      const cleanOut = path.join(scratch, "story.json");
      const clean = await runPython(MODULE_PATHS.cleanup,
        ["--pages", ...saved, "--out", cleanOut]);
      // A refusal, not a failure. The cleanup stage measures how much of the page it could
      // actually read and stops rather than inventing the rest -- which is what produced a
      // complete, fluent, entirely different story from four unreadable photographs.
      const refused = clean.stdout.split(/\r?\n/)
        .find((l) => l.startsWith("PAGES_UNREADABLE "));
      if (refused) {
        const d = JSON.parse(refused.slice("PAGES_UNREADABLE ".length)) as {
          readable_fraction: number; what_is_wrong: string; pages_too_hard: string[];
          columns: number; language: string;
        };
        const pct = Math.round((d.readable_fraction ?? 0) * 100);
        const bad = d.pages_too_hard?.length ?? 0;
        const which = bad === 1 ? "This photo is"
          : bad >= photos.length ? `All ${bad} photos are`
          : `${bad} of the photos are`;
        return Response.json({
          error: `${which} too hard to read. Only about ${pct}% of the words came out, `
               + "so the story would have been mostly guesswork.",
          step: "Read the pages",
          hint: d.what_is_wrong,
          advice: [
            "Send the original photo from the camera, not a screenshot of it -- a screenshot "
            + "throws away most of the detail.",
            "Hold the phone flat above the page, not at an angle, with the whole page in view.",
            d.columns >= 2
              ? "This page has two columns of text. Photograph one page at a time so the "
                + "words are as large as possible."
              : "Fill the frame with the page so the words are as large as possible.",
            "Good light, no shadow of your hand or phone falling across the words.",
          ],
          pagesTooHard: d.pages_too_hard ?? [],
          readablePercent: pct,
        }, { status: 422 });
      }
      if (clean.code !== 0) throw new Error(`Could not make sense of the pages. ${clean.stderr.slice(-400)}`);
      story = await readJson(cleanOut);
    } else {
      story = {
        title: guessTitle(typed),
        story_text: typed,
        moral: "",
        language: "English",
        photo_complete: true,
        reconstructions: [],
        pages: [],
        note_for_her: "",
      };
    }
    if (!story) throw new Error("Could not read the story.");

    // Now that the title is known, give the story its real folder. Prefer the English
    // title: a Telugu one makes a correct but unpronounceable folder that neither of us can
    // type at a shell. storySlug keeps Telugu intact as the fallback.
    const dir = path.join(STORIES_ROOT, storySlug(
      String(story.title_english || story.title || "")));
    if (await exists(dir)) await fs.rm(dir, { recursive: true, force: true });
    await fs.rename(scratch, dir);
    await fs.writeFile(path.join(dir, "story.json"), JSON.stringify(story, null, 2), "utf8");
    if (!photos.length) {
      await fs.mkdir(path.join(dir, "pages"), { recursive: true });
      await fs.copyFile(FALLBACK_STYLE_PAGE, path.join(dir, "pages", "house-style.jpeg"));
    }

    const filled = (story.reconstructions as Array<Record<string, string>> | undefined) ?? [];
    return Response.json({
      storyDir: dir,
      title: story.title,
      storyText: story.story_text,
      moral: story.moral,
      photoComplete: story.photo_complete !== false,
      filledIn: filled.map((r) => ({
        before: r.visible_before, inserted: r.inserted,
        after: r.visible_after, confidence: r.confidence,
      })),
      note: story.note_for_her ?? "",
    });
  } catch (caught) {
    return fail('Read the story', caught,
      { status: 500, hint: 'The photos are saved. Press the same button again to read them again.' });
  }
}
