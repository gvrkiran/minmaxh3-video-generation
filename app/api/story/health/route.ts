/** Is everything running? Answerable from a phone, without a terminal.
 *
 * This exists because "is it working" turned out to be a hard question to answer. The services
 * had died silently -- empty error logs, nothing listening -- and the only way to find out was
 * to open a shell and probe ports. Kiran should be able to check from a browser, and if it
 * says something is down, the watchdog will already be putting it back.
 *
 * It reports each service by what it DOES rather than by port number, because a plain answer
 * is the point. The GPU line matters too: only one video can be made at a time, so "nothing is
 * happening" and "your video is queued behind another one" look identical from outside.
 */
import { promises as fs } from "node:fs";
import { fail, join, readJson, STORIES_ROOT, STUDIO_ROOT } from "@/lib/story-runner";

export const dynamic = "force-dynamic";

type Held = { pid?: number; label?: string; story?: string; at?: number };

/** A listening port is the only honest test -- a process can be alive and not serving. */
async function serving(port: number, path: string): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      signal: AbortSignal.timeout(4000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function alive(pid: number): Promise<boolean> {
  // The watchdog already resolves this; this is for renders started since its last pass.
  try {
    process.kill(pid, 0);          // signal 0 tests existence without touching the process
    return true;
  } catch (caught) {
    return (caught as { code?: string }).code === "EPERM";
  }
}

export async function GET() {
  try {
    const [comfy, voice] = await Promise.all([
      serving(8188, "/system_stats"),
      serving(8190, "/health"),
    ]);

    // This route answering at all proves the website is up, so it is not probed.
    const services = {
      website: { up: true, does: "the pages she uses" },
      pictures: { up: comfy, does: "drawing the characters and making the video" },
      voice: { up: voice, does: "reading the story aloud in Telugu" },
    };

    const gpu = await readJson<Held>(join(STUDIO_ROOT, "gpu.lock"));
    const busy = gpu?.pid && await alive(gpu.pid)
      ? { making: gpu.label ?? "a video", forStory: gpu.story ?? "", since: gpu.at ?? null }
      : null;

    // Any story with a live driver on it.
    const running: Array<{ story: string; pid: number }> = [];
    for (const name of await fs.readdir(STORIES_ROOT).catch(() => [])) {
      const held = await readJson<Held>(join(STORIES_ROOT, name, "pipeline.lock"));
      if (held?.pid && await alive(held.pid)) running.push({ story: name, pid: held.pid });
    }

    const watchdog = await readJson<{ checkedAt?: string }>(
      join(STUDIO_ROOT, "app", "work", "health.json"));
    const lastCheck = watchdog?.checkedAt ? Date.parse(watchdog.checkedAt) : null;
    const minutesSinceCheck = lastCheck
      ? Math.round((Date.now() - lastCheck) / 60000) : null;

    const allUp = Object.values(services).every((s) => s.up);
    return Response.json({
      ok: allUp,
      summary: allUp
        ? "Everything is running."
        : "Something is not running. It should come back on its own within a few minutes.",
      services,
      makingAVideoNow: busy,
      rendersRunning: running,
      watchdog: {
        // Stale means the scheduled task is not firing, which is its own kind of broken.
        lastCheckedMinutesAgo: minutesSinceCheck,
        healthy: minutesSinceCheck !== null && minutesSinceCheck <= 15,
      },
    }, { headers: { "cache-control": "no-store" } });
  } catch (caught) {
    return fail("Check that everything is running", caught,
      { status: 500, hint: "The website is up, since it answered at all." });
  }
}
