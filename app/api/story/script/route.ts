/** Screen 5: split into scenes, write the Telugu, then speak it so she can hear it first.
 *
 * Narration runs here rather than with the video because the whole pipeline is audio-first:
 * the wav decides how long each shot is, and a minute of listening now replaces forty
 * minutes of regret later.
 */
import path from "node:path";
import {
  MODULE_PATHS, readJson, readProgress, runPython, safeStoryDir, fail,
} from "@/lib/story-runner";
import { renameToTitle } from "@/lib/rename-story";

export const dynamic = "force-dynamic";

type Script = {
  title?: string;
  telugu_moral?: string;
  scenes?: Array<{ problems?: string[] }>;
};

export async function POST(request: Request) {
  try {
    const body = await request.json() as { storyDir?: string };
    let dir = safeStoryDir(body.storyDir);

    const written = await runPython(MODULE_PATHS.script,
      ["--story", path.join(dir, "story.json"), "--cast", path.join(dir, "cast.json"),
        "--out", path.join(dir, "script.json")]);
    if (written.code !== 0) throw new Error(`Could not plan the scenes. ${written.stderr.slice(-500)}`);

    const script = await readJson<Script>(path.join(dir, "script.json"));
    const problems = (script?.scenes ?? []).flatMap((s) => s.problems ?? []);
    if (problems.length) {
      // The validator exists precisely so a bad plan never reaches the GPU.
      return Response.json(
        { error: `The scene plan failed its checks: ${problems.slice(0, 3).join("; ")}` },
        { status: 422 },
      );
    }

    // The story's real title only exists now, so this is the moment to file it under that
    // name: nothing is rendering, and no file yet written mentions the path. Before this it
    // was named from a guess at the opening words -- once from an instruction she had pasted
    // in by mistake. Everything below uses `dir`, which is where the story now lives.
    const moved = await renameToTitle(dir);
    dir = moved.dir;
    if (moved.renamed) console.log(`renamed story ${moved.from} -> ${moved.to}`);

    const spoken = await runPython(MODULE_PATHS.pipeline,
      ["--story-dir", dir, "--only-stage", "narrate"], 1_200_000);
    if (spoken.code !== 0) throw new Error(`Could not record the telling. ${spoken.stderr.slice(-500)}`);

    const fitted = await runPython(MODULE_PATHS.pipeline, ["--story-dir", dir, "--only-stage", "fit"]);
    if (fitted.code !== 0) throw new Error(`Could not time the scenes. ${fitted.stderr.slice(-400)}`);

    const progress = await readProgress(dir);
    return Response.json({
      // The folder may have just been renamed, so hand the client the current path. Using
      // the one it sent would point at a directory that no longer exists.
      storyDir: dir,
      title: script?.title ?? "",
      moral: script?.telugu_moral ?? "",
      scenes: progress.scenes.map((scene) => {
        const rel = `narration/scene_${String(scene.index).padStart(2, "0")}.wav`;
        return {
          ...scene,
          audio: `/api/story/file?dir=${encodeURIComponent(dir)}&rel=${encodeURIComponent(rel)}`,
        };
      }),
    });
  } catch (caught) {
    return fail('Plan the scenes', caught,
      { status: 500, hint: 'Nothing was lost. Press the same button again.' });
  }
}
