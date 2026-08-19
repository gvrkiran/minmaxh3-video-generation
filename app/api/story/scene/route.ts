/** Screen 7: redo one scene from her note.
 *
 * Detached, because a single re-render is ~4.6 min of GPU plus the re-join. Progress is read
 * back through /api/story/progress like the first render, so the UI needs no new plumbing.
 */
import { promises as fs } from "node:fs";
import {
  MODULE_PATHS, join, readJson, readProgress, safeStoryDir, startDetached,
} from "@/lib/story-runner";

export const dynamic = "force-dynamic";

type Script = { scenes?: Array<{ index: number }> };

export async function POST(request: Request) {
  try {
    const body = await request.json() as {
      storyDir?: string; index?: number; note?: string; aspect?: string;
    };
    const dir = safeStoryDir(body.storyDir);
    const index = Number(body.index);
    if (!Number.isInteger(index) || index < 1) {
      return Response.json({ error: "Which scene should I redo?" }, { status: 400 });
    }

    const script = await readJson<Script>(join(dir, "script.json"));
    if (!script?.scenes?.some((s) => s.index === index)) {
      return Response.json({ error: `This story has no scene ${index}.` }, { status: 400 });
    }

    // Refuse to stack redos: the pipeline holds a per-story lock anyway, but saying so here
    // is clearer than letting her press the button twice and wonder which one is running.
    if (await fs.access(join(dir, "pipeline.lock")).then(() => true, () => false)) {
      return Response.json(
        { error: "Something is already being made for this story. Give it a moment." },
        { status: 409 },
      );
    }

    const aspect = body.aspect === "16:9" ? "16:9" : "9:16";
    const pid = await startDetached(dir, MODULE_PATHS.regenScene, [
      "--story-dir", dir,
      "--index", String(index),
      "--note", (body.note ?? "").trim(),
      "--aspect", aspect,
    ], "redo");

    return Response.json({ started: true, pid, index, progress: await readProgress(dir) });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "Could not redo that scene.";
    return Response.json({ error: message }, { status: 500 });
  }
}
