/** Everything about every job, for Kiran's dashboard.
 *
 * She sees one story at a time and needs nothing else. He needs the opposite view: what is
 * running, what is queued behind it, what failed and why, what she has asked to be changed,
 * and what it has all cost. None of that was visible anywhere -- the answers were spread
 * across a dozen files per story, and finding out meant reading them by hand.
 *
 * There is no job queue to read, because the pipeline does not have one. A job's state IS the
 * files on disk: a lock file means a live driver, a final.mp4 means finished, a non-empty
 * .err means it fell over. That is deliberate and it is why a killed render could be resumed
 * without losing anything -- but it does mean the state has to be derived here rather than
 * looked up.
 */
import { promises as fs } from "node:fs";
import { fail, join, readJson, STORIES_ROOT, STUDIO_ROOT } from "@/lib/story-runner";
import { listReelJobs } from "@/lib/reels-runner";

export const dynamic = "force-dynamic";

// gpt-5.5, USD per 1M tokens. Output dominates every bill here by roughly twenty to one.
const IN_PER_M = 5.0;
const OUT_PER_M = 30.0;

type Usage = { prompt_tokens?: number; completion_tokens?: number };
type Meta = { seconds?: number; usage?: Usage; model?: string };
type Story = {
  title?: string; title_english?: string; language?: string;
  photo_complete?: boolean; reconstructions?: unknown[]; note_for_her?: string;
  _meta?: Meta; _read?: { seconds?: number; recovered?: number; real_chars?: number;
                          columns?: number; language_seen?: string };
};
type Script = {
  title?: string; telugu_moral?: string; moral_english?: string;
  scenes?: Array<{ index: number; summary_for_her?: string }>;
  scenes_over_cap?: number; _meta?: Meta;
};
type Cast = { characters?: unknown[]; _meta?: Meta };
type State = {
  stages?: Record<string, string>; aspect?: string; updatedAt?: number; final?: string;
};
type Lock = { pid?: number; label?: string; story?: string; at?: number };
type Edits = {
  scenes?: Array<{ index: number; note?: string; telugu?: string; remove?: boolean }>;
  moral?: { telugu?: string };
};

function alive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (caught) {
    return (caught as { code?: string }).code === "EPERM";
  }
}

function dollars(...metas: Array<Meta | undefined>): number {
  let total = 0;
  for (const m of metas) {
    const u = m?.usage;
    if (!u) continue;
    total += (u.prompt_tokens ?? 0) / 1e6 * IN_PER_M
           + (u.completion_tokens ?? 0) / 1e6 * OUT_PER_M;
  }
  return Math.round(total * 1000) / 1000;
}

async function countIn(dir: string, ext: string): Promise<number> {
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  return names.filter((n) => n.endsWith(ext)).length;
}

/** The tail of an error file, or null. Empty files are the normal case, not a failure. */
async function errorTail(path: string): Promise<string | null> {
  const bytes = await fs.readFile(path).catch(() => null);
  if (!bytes) return null;
  const text = new TextDecoder("utf-8").decode(bytes).trim();
  if (!text) return null;
  return text.split("\n").slice(-4).join(" ").slice(0, 400);
}

export async function GET() {
  try {
    const gpu = await readJson<Lock>(join(STUDIO_ROOT, "gpu.lock"));
    const gpuHeld = alive(gpu?.pid) ? gpu : null;

    const names = (await fs.readdir(STORIES_ROOT).catch(() => [] as string[])).sort();
    const jobs = [];

    for (const name of names) {
      const dir = join(STORIES_ROOT, name);
      const stat = await fs.stat(dir).catch(() => null);
      if (!stat?.isDirectory()) continue;

      const [story, script, cast, state, lock] = await Promise.all([
        readJson<Story>(join(dir, "story.json")),
        readJson<Script>(join(dir, "script.json")),
        readJson<Cast>(join(dir, "cast.json")),
        readJson<State>(join(dir, "state.json")),
        readJson<Lock>(join(dir, "pipeline.lock")),
      ]);

      const finalStat = await fs.stat(join(dir, "final.mp4")).catch(() => null);
      const [pages, shots, audio] = await Promise.all([
        countIn(join(dir, "pages"), ""),
        countIn(join(dir, "shots"), ".mp4"),
        countIn(join(dir, "narration"), ".wav"),
      ]);
      const totalScenes = script?.scenes?.length ?? 0;

      const [renderErr, editErr] = await Promise.all([
        errorTail(join(dir, "render.err")),
        errorTail(join(dir, "edit.err")),
      ]);

      const [pending, lastEdit] = await Promise.all([
        readJson<Edits>(join(dir, "pending-edits.json")),
        readJson<{ applied?: string[] }>(join(dir, "last-edit.json")),
      ]);
      // A plan on disk does not mean work outstanding. Older runs left the plan behind after
      // applying it, so half of what looked outstanding was already done. Timestamps settle
      // it: a plan is only waiting if nothing has been applied since it was written.
      const [planStat, appliedStat] = await Promise.all([
        fs.stat(join(dir, "pending-edits.json")).catch(() => null),
        fs.stat(join(dir, "last-edit.json")).catch(() => null),
      ]);
      const planIsStale = planStat !== null && appliedStat !== null
        && appliedStat.mtimeMs >= planStat.mtimeMs;
      // And a plan the editor refused is not waiting either -- it needs her to change it.
      const editRefusal = editErr && planStat ? editErr : null;

      const driverAlive = alive(lock?.pid);
      // A live driver that does NOT hold the GPU is queued behind whoever does. That
      // distinction is the whole point of the dashboard: without it, a queued story and a
      // wedged one look the same.
      const holdsGpu = driverAlive && gpuHeld?.pid === lock?.pid;
      const queued = driverAlive && !holdsGpu && gpuHeld !== null;

      let status: string;
      let detail: string;
      if (driverAlive && queued) {
        status = "queued";
        detail = `waiting for ${gpuHeld?.story || "another story"}`;
      } else if (driverAlive) {
        status = "running";
        detail = totalScenes ? `scene ${Math.min(shots + 1, totalScenes)} of ${totalScenes}` : "working";
      } else if (finalStat) {
        status = "done";
        detail = `${totalScenes} scenes`;
      } else if (renderErr || editErr) {
        status = "failed";
        detail = (renderErr || editErr) as string;
      } else if (name.startsWith("_incoming-")) {
        // Ingest writes into a scratch folder and renames it once the title is known. One
        // left behind means the read was refused or crashed before that point.
        status = "abandoned";
        detail = "photos uploaded, never became a story";
      } else if (totalScenes) {
        status = "ready to make";
        detail = `${totalScenes} scenes planned`;
      } else if (cast?.characters?.length) {
        status = "needs a scene plan";
        detail = `${cast.characters.length} characters drawn`;
      } else if (story) {
        status = "needs characters";
        detail = story.language ?? "";
      } else {
        status = "just photos";
        detail = `${pages} page(s)`;
      }

      jobs.push({
        name,
        title: script?.title || story?.title || name,
        englishTitle: story?.title_english || "",
        language: story?.language || story?._read?.language_seen || "",
        status,
        detail,
        pages,
        scenes: totalScenes,
        shotsDone: shots,
        audioDone: audio,
        scenesOverCap: script?.scenes_over_cap ?? null,
        aspect: state?.aspect ?? null,
        finishedAt: finalStat?.mtimeMs ?? null,
        sizeMb: finalStat ? Math.round(finalStat.size / 1e5) / 10 : null,
        updatedAt: state?.updatedAt ?? stat.mtimeMs,
        readSeconds: story?._read?.seconds ?? null,
        recovered: story?._read?.recovered ?? null,
        columns: story?._read?.columns ?? null,
        photoComplete: story?.photo_complete ?? null,
        filledSpans: story?.reconstructions?.length ?? 0,
        noteForHer: story?.note_for_her || "",
        costUsd: dollars(story?._meta, cast?._meta, script?._meta),
        stages: state?.stages ?? {},
        error: renderErr || editErr || null,
        // Her own words, verbatim. This is the part he cannot get anywhere else.
        editsRefused: editRefusal,
        editsPending: (planIsStale ? [] : pending?.scenes ?? [])
          .filter((s) => s.note?.trim() || s.telugu?.trim() || s.remove)
          .map((s) => ({
            scene: s.index,
            asked: s.note?.trim() || (s.telugu?.trim() ? "reworded the narration" : "")
                   || (s.remove ? "leave this scene out" : ""),
            kind: s.remove ? "remove" : s.note?.trim() ? "note" : "telugu",
          })),
        editsApplied: lastEdit?.applied ?? [],
      });
    }

    // Newest activity first -- that is what he wants to see on opening it.
    jobs.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));

    const errLog = await fs.readFile(join(STUDIO_ROOT, "app", "work", "story-errors.log"))
      .catch(() => null);
    const recentErrors = errLog
      ? new TextDecoder("utf-8").decode(errLog).trim().split("\n").slice(-12).reverse()
        .map((line) => line.slice(0, 260))
      : [];

    // Never let the garden panel take the whole dashboard down with it.
    const reels = await listReelJobs().catch(() => []);

    const watchdog = await readJson<{ checkedAt?: string }>(
      join(STUDIO_ROOT, "app", "work", "health.json"));
    const lastCheck = watchdog?.checkedAt ? Date.parse(watchdog.checkedAt) : null;

    return Response.json({
      now: Date.now(),
      gpu: gpuHeld
        ? { making: gpuHeld.label, forStory: gpuHeld.story, pid: gpuHeld.pid, since: gpuHeld.at }
        : null,
      watchdogMinutesAgo: lastCheck ? Math.round((Date.now() - lastCheck) / 60000) : null,
      totals: {
        stories: jobs.length,
        finished: jobs.filter((j) => j.status === "done").length,
        running: jobs.filter((j) => j.status === "running").length,
        queued: jobs.filter((j) => j.status === "queued").length,
        failed: jobs.filter((j) => j.status === "failed").length,
        editsWaiting: jobs.reduce((n, j) => n + j.editsPending.length, 0),
        spentUsd: Math.round(jobs.reduce((n, j) => n + j.costUsd, 0) * 100) / 100,
      },
      jobs,
      // Reels typed through /garden. Kept as their own list rather than merged into
      // `jobs`: different shape, different owner, and merging would make every story
      // field optional for no gain.
      reels,
      recentErrors,
    }, { headers: { "cache-control": "no-store" } });
  } catch (caught) {
    return fail("Load the dashboard", caught, { status: 500 });
  }
}
