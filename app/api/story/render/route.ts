/** Screen 6: start the long part, detached, and let her close the laptop. */
import { fail, readProgress, safeStoryDir, startRender } from "@/lib/story-runner";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await request.json() as { storyDir?: string; aspect?: string; voice?: string };
    const dir = safeStoryDir(body.storyDir);
    const aspect = body.aspect === "16:9" ? "16:9" : "9:16";
    const voice = body.voice === "male" ? "male" : "female";

    // Already finished, or already running: don't start a second one. The pipeline holds a
    // per-story lock as well, but refusing here keeps the UI honest.
    const before = await readProgress(dir);
    if (before.finalReady) return Response.json({ started: false, progress: before });

    const pid = await startRender(dir, aspect, voice);
    return Response.json({ started: true, pid, progress: await readProgress(dir) });
  } catch (caught) {
    return fail('Make my video', caught,
      { status: 500, hint: 'Scenes already finished are kept; it carries on from where it stopped.' });
  }
}
