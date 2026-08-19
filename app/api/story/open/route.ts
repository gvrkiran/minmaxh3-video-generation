/** Load a finished story back into the editor.
 *
 * This is what makes editing survive closing the laptop: everything the editor needs is
 * read off disk, so she can come back to a film made last week and change a scene. Nothing
 * about editing depends on the session that made it.
 */
import { fail, join, readJson, readProgress, safeStoryDir } from "@/lib/story-runner";

export const dynamic = "force-dynamic";

type Script = {
  title?: string;
  telugu_moral?: string;
  moral_english?: string;
  moral_source?: string;
  scenes?: Array<{
    index: number;
    summary_for_her: string;
    telugu_narration: string;
    subject_names?: string[];
    revision_note?: string;
    what_changed?: string;
  }>;
};

export async function GET(request: Request) {
  try {
    const dir = safeStoryDir(new URL(request.url).searchParams.get("dir"));
    const script = await readJson<Script>(join(dir, "script.json"));
    const story = await readJson<{ title?: string }>(join(dir, "story.json"));
    if (!script?.scenes?.length) {
      throw new Error("This story has no scene plan yet, so there is nothing to edit.");
    }
    const progress = await readProgress(dir);
    const lastEdit = await readJson<{ applied?: string[] }>(join(dir, "last-edit.json"));
    const byIndex = new Map(progress.scenes.map((s) => [s.index, s]));

    const clip = (rel: string) =>
      `/api/story/file?dir=${encodeURIComponent(dir)}&rel=${encodeURIComponent(rel)}`;

    return Response.json({
      storyDir: dir,
      title: story?.title ?? "",
      teluguTitle: script.title ?? "",
      moral: {
        telugu: script.telugu_moral ?? "",
        english: script.moral_english ?? "",
        source: script.moral_source ?? "",
        video: progress.scenes.length ? clip("narrated/zz_moral.mp4") : null,
      },
      finalVideo: progress.finalReady ? clip("final.mp4") : null,
      progress,
      lastApplied: lastEdit?.applied ?? [],
      scenes: script.scenes.map((scene) => {
        const pad = String(scene.index).padStart(2, "0");
        const live = byIndex.get(scene.index);
        return {
          index: scene.index,
          summary: scene.summary_for_her,
          telugu: scene.telugu_narration,
          characters: scene.subject_names ?? [],
          seconds: live?.seconds,
          ready: Boolean(live?.hasShot),
          // The narrated cut, not the raw shot: it is the one with her voice on it.
          video: live?.hasShot ? clip(`narrated/scene_${pad}.mp4`) : null,
          audio: live?.hasAudio ? clip(`narration/scene_${pad}.wav`) : null,
          lastNote: scene.revision_note ?? "",
          lastChange: scene.what_changed ?? "",
        };
      }),
    });
  } catch (caught) {
    return fail("Open the video for editing", caught,
      { status: 500, hint: "Nothing was changed. Try opening it again." });
  }
}
