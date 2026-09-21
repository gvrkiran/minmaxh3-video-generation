/** Screen 2 -> 3: start the long part, detached, so she can close the laptop. */
import { readReelProgress, safeSlug, startReelRender } from "@/lib/reels-runner";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await request.json() as { slug?: string };
    const slug = safeSlug(body.slug);

    // Already finished: don't queue a second render of the same thing. reels.py holds its
    // own lab-wide RunLock as well, but refusing here keeps the screen honest.
    const before = await readReelProgress(slug);
    if (before.ready) return Response.json({ started: false, progress: before });

    const pid = await startReelRender(slug);
    return Response.json({ started: true, pid, progress: await readReelProgress(slug) });
  } catch (caught) {
    const detail = caught instanceof Error ? caught.message : "Could not start.";
    return Response.json({
      error: "Could not start making the video.",
      hint: "Pictures already finished are kept; it carries on from where it stopped.",
      detail,
    }, { status: 500 });
  }
}
