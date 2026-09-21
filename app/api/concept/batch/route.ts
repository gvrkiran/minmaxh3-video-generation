/**
 * Several concepts at once: the lines in the /concept box, made one after another.
 *
 * There is no separate list page for concepts -- the same box takes one line or many. One line
 * goes through the plan screen; two or more come here and are handed to the batch driver, which
 * plans and renders them in order with nobody asked to approve anything, exactly as the garden
 * and painting lists are made. POST returns as soon as the driver is spawned; the work outlives
 * the request, and the page reads progress back off the filesystem through GET and through the
 * "being made now" shelf.
 *
 * The driver and the lock are shared with the other kinds: one graphics card, one list at a
 * time, whichever kind it is. GET filters to concept lists only.
 */
import { createBatch, listBatches, readBatch, MAX_IDEAS, MINUTES_PER_REEL } from "@/lib/reels-batch";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await request.json() as { ideas?: string };
    const { id, skipped, appended } = await createBatch(body.ideas, "concept");
    // `skipped` is not an error: blank lines, comments and repeats are dropped on purpose,
    // but silently dropping a line someone typed is how you lose an idea without noticing.
    // `appended` is set when a list was already running and the lines joined its end.
    return Response.json({ id, skipped, appended: appended ?? 0, batch: await readBatch(id) });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "Could not start the list.";
    return Response.json({ error: message, maxIdeas: MAX_IDEAS, minutesPerReel: MINUTES_PER_REEL },
      { status: 400 });
  }
}

export async function GET(request: Request) {
  try {
    const id = new URL(request.url).searchParams.get("id");
    if (id) return Response.json({ batch: await readBatch(id) });
    return Response.json({ batches: await listBatches("concept") });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "Could not read the list.";
    return Response.json({ error: message }, { status: 404 });
  }
}
