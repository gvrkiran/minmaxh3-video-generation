/** Screen 2 -> 3: take the pages in, read them, hand back a complete story. */
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  MODULE_PATHS, STORIES_ROOT, exists, readJson, runPython, storySlug,
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
      const ocrOut = path.join(scratch, "ocr.json");
      const ocr = await runPython(MODULE_PATHS.ocr, [...saved, "--out", ocrOut]);
      if (ocr.code !== 0) throw new Error(`Could not read the pages. ${ocr.stderr.slice(-400)}`);

      const cleanOut = path.join(scratch, "story.json");
      const clean = await runPython(MODULE_PATHS.cleanup,
        ["--ocr", ocrOut, "--pages", ...saved, "--out", cleanOut]);
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

    // Now that the title is known, give the story its real folder.
    const dir = path.join(STORIES_ROOT, storySlug(String(story.title ?? "")));
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
    const message = caught instanceof Error ? caught.message : "Could not read the story.";
    return Response.json({ error: message }, { status: 500 });
  }
}
