/** Screen 1: her finished videos, newest first. */
import { promises as fs } from "node:fs";
import path from "node:path";
import { STORIES_ROOT, exists, readJson } from "@/lib/story-runner";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    if (!(await exists(STORIES_ROOT))) return Response.json({ stories: [] });
    const entries = await fs.readdir(STORIES_ROOT, { withFileTypes: true });

    const stories = (await Promise.all(entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("_"))
      .map(async (entry) => {
        const dir = path.join(STORIES_ROOT, entry.name);
        const final = path.join(dir, "final.mp4");
        if (!(await exists(final))) return null;
        const stat = await fs.stat(final);
        const story = await readJson<{ title?: string }>(path.join(dir, "story.json"));
        const script = await readJson<{ title?: string; scenes?: unknown[] }>(
          path.join(dir, "script.json"));
        return {
          dir,
          slug: entry.name,
          title: story?.title ?? entry.name,
          teluguTitle: script?.title ?? "",
          scenes: script?.scenes?.length ?? 0,
          madeAt: stat.mtimeMs,
          megabytes: Math.round((stat.size / 1024 ** 2) * 10) / 10,
          video: `/api/story/file?dir=${encodeURIComponent(dir)}&rel=final.mp4`,
        };
      })))
      .filter((s): s is NonNullable<typeof s> => Boolean(s))
      .sort((a, b) => b.madeAt - a.madeAt);

    return Response.json({ stories });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "Could not list your videos.";
    return Response.json({ error: message }, { status: 500 });
  }
}
