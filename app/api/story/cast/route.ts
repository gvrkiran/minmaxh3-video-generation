/** Screen 4: work out who is in the story and draw them, or redraw one on request. */
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  LIBRARY_ROOT, MODULE_PATHS, readJson, runPython, safeStoryDir, fail,
} from "@/lib/story-runner";

export const dynamic = "force-dynamic";

type CastFile = { style_paragraph?: string; characters?: Array<{ name: string }> };
type Record_ = {
  characterKey: string; name: string; species: string; role?: string;
  description: string; filename: string; createdAt: number;
};

async function castPayload(dir: string) {
  const cast = await readJson<CastFile>(path.join(dir, "cast.json"));
  const wanted = (cast?.characters ?? []).map((c) => c.name);
  const files = await fs.readdir(LIBRARY_ROOT).catch(() => [] as string[]);
  const records = (await Promise.all(
    files.filter((f) => f.endsWith(".json")).map((f) => readJson<Record_>(path.join(LIBRARY_ROOT, f))),
  )).filter((r): r is Record_ => r !== null && wanted.includes(r.name));

  // Keep her cast in the order the extractor ranked them, not the order the disk happens to list.
  records.sort((a, b) => wanted.indexOf(a.name) - wanted.indexOf(b.name));
  return {
    style: cast?.style_paragraph ?? "",
    characters: records.map((r) => ({
      key: r.characterKey,
      name: r.name,
      species: r.species,
      role: r.role ?? "",
      appearance: r.description,
      // cache-bust on createdAt so a redraw actually shows up
      portrait: `/api/story/file?library=${encodeURIComponent(r.filename)}&v=${r.createdAt}`,
    })),
  };
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as {
      storyDir?: string; redraw?: string; note?: string;
      title?: string; storyText?: string;
    };
    const dir = safeStoryDir(body.storyDir);

    // Save whatever she corrected on the review screen FIRST. Everything downstream reads
    // story.json off disk, so without this her edits were displayed and then discarded.
    if (typeof body.storyText === "string" || typeof body.title === "string") {
      const stored = await readJson<Record<string, unknown>>(path.join(dir, "story.json")) ?? {};
      if (body.title?.trim()) stored.title = body.title.trim();
      if (body.storyText?.trim()) stored.story_text = body.storyText;
      stored.editedByHer = true;
      await fs.writeFile(path.join(dir, "story.json"), JSON.stringify(stored, null, 2), "utf8");
    }

    // Qwen-Image-Edit needs an input image, and her own page is the style anchor that makes
    // the cast look like it came out of her book.
    const pages = (await fs.readdir(path.join(dir, "pages")).catch(() => [] as string[])).sort();
    if (!pages.length) throw new Error("This story has no page image to take its style from.");
    const styleRef = path.join(dir, "pages", pages[0]);

    if (body.redraw) {
      // --reseed because a redraw is an explicit request for something different. Without
      // it, "Try again" with no note reproduced the identical image from the same seed.
      const args = ["--cast", path.join(dir, "cast.json"), "--style-ref", styleRef,
        "--only", body.redraw, "--reseed"];
      if (body.note?.trim()) args.push("--note", body.note.trim());
      const redrawn = await runPython(MODULE_PATHS.buildCast, args);
      if (redrawn.code !== 0) {
        throw new Error(`Could not redraw that character. ${redrawn.stderr.slice(-400)}`);
      }
      return Response.json(await castPayload(dir));
    }

    const extracted = await runPython(MODULE_PATHS.cast,
      ["--story", path.join(dir, "story.json"),
        "--pages", ...pages.map((p) => path.join(dir, "pages", p)),
        "--out", path.join(dir, "cast.json")]);
    if (extracted.code !== 0) {
      throw new Error(`Could not work out the characters. ${extracted.stderr.slice(-400)}`);
    }

    // --reuse: a character already in the library is the same character, so keep her fox.
    const drawn = await runPython(MODULE_PATHS.buildCast,
      ["--cast", path.join(dir, "cast.json"), "--style-ref", styleRef, "--reuse"]);
    if (drawn.code !== 0) throw new Error(`Could not draw the characters. ${drawn.stderr.slice(-400)}`);

    return Response.json(await castPayload(dir));
  } catch (caught) {
    return fail('Meet the characters', caught,
      { status: 500, hint: 'Characters already drawn are kept. Press the same button again.' });
  }
}
