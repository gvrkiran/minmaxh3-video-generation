/** Apply a batch of her edits and rebuild the film.
 *
 * Batched rather than one scene at a time: she watches the whole thing, marks everything she
 * wants changed, and presses once. One pass also means the video model loads once instead of
 * once per change, which is most of the cost.
 *
 * Detached, because rebuilding is minutes of GPU. Progress comes back through
 * /api/story/progress, the same channel the first render uses.
 */
import { promises as fs } from "node:fs";
import {
  MODULE_PATHS, exists, fail, join, readJson, readProgress, safeStoryDir, startDetached,
} from "@/lib/story-runner";

export const dynamic = "force-dynamic";

type SceneEdit = { index?: number; note?: string; telugu?: string; remove?: boolean };
type Body = {
  storyDir?: string;
  scenes?: SceneEdit[];
  moral?: { telugu?: string; english?: string };
  aspect?: string;
};
type Script = { scenes?: Array<{ index: number }> };

export async function POST(request: Request) {
  try {
    const body = await request.json() as Body;
    const dir = safeStoryDir(body.storyDir);

    if (await exists(join(dir, "pipeline.lock"))) {
      return Response.json(
        { error: "This video is already being worked on. Give it a moment and try again.",
          step: "Make the changes",
          hint: "Nothing was lost. The screen will update on its own when it finishes." },
        { status: 409 },
      );
    }

    const script = await readJson<Script>(join(dir, "script.json"));
    const known = new Set((script?.scenes ?? []).map((s) => s.index));

    // Keep only edits that actually ask for something, so an untouched scene is never
    // re-rendered just because its row was on screen.
    const scenes = (body.scenes ?? []).filter((edit) => {
      const index = Number(edit.index);
      if (!known.has(index)) return false;
      return Boolean(edit.remove) || Boolean(edit.note?.trim()) || Boolean(edit.telugu?.trim());
    }).map((edit) => ({
      index: Number(edit.index),
      note: (edit.note ?? "").trim(),
      telugu: (edit.telugu ?? "").trim(),
      remove: Boolean(edit.remove),
    }));

    const moral = body.moral?.telugu?.trim()
      ? { telugu: body.moral.telugu.trim(), english: (body.moral.english ?? "").trim() }
      : undefined;

    if (!scenes.length && !moral) {
      return Response.json(
        { error: "Nothing has been changed yet.", step: "Make the changes",
          hint: "Say what is wrong with a scene, or reword what the narrator says, then press this again." },
        { status: 400 },
      );
    }

    if (scenes.filter((s) => s.remove).length >= known.size) {
      return Response.json(
        { error: "That would remove every scene. At least one has to stay.",
          step: "Make the changes", hint: "Untick one of the scenes you marked for removal." },
        { status: 400 },
      );
    }

    const plan = join(dir, "pending-edits.json");
    await fs.writeFile(plan, JSON.stringify({ scenes, moral }, null, 2), "utf8");

    const pid = await startDetached(dir, MODULE_PATHS.applyEdits, [
      "--story-dir", dir,
      "--edits", plan,
      "--aspect", body.aspect === "16:9" ? "16:9" : "9:16",
    ], "edit");

    return Response.json({
      started: true,
      pid,
      changing: scenes.map((s) => s.index),
      moralChanged: Boolean(moral),
      progress: await readProgress(dir),
    });
  } catch (caught) {
    return fail("Make the changes", caught,
      { status: 500, hint: "Your video is untouched. Try pressing it again." });
  }
}
