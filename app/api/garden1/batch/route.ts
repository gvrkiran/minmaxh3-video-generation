/**
 * Start a list, or read where it has got to.
 *
 * POST returns as soon as the driver is spawned -- it does not wait for the first plan, let
 * alone the first render. The whole point of this endpoint is that the work outlives the
 * request that started it.
 */
import { createBatch, listBatches, readBatch, MAX_IDEAS, MINUTES_PER_REEL } from "@/lib/reels-batch";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await request.json() as { ideas?: string };
    const { id, skipped } = await createBatch(body.ideas);
    // `skipped` is not an error: blank lines, comments and repeats are dropped on purpose,
    // but silently dropping a line someone typed is how you lose an idea without noticing.
    return Response.json({ id, skipped, batch: await readBatch(id) });
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
    // Gardening lists only; the painting lists have their own page.
    return Response.json({ batches: await listBatches("garden") });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "Could not read the list.";
    return Response.json({ error: message }, { status: 404 });
  }
}
