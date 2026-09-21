/**
 * Stop a running concept list, set it going again, or retry everything unfinished.
 *
 * One POST with an `action`, as on the other list pages, because the three are the same button
 * in different states. "Resume" covers the machine rebooting mid-list, someone stopping it and
 * changing their mind, and two ideas failing: the driver skips what is finished and redoes only
 * what is missing. "retry-all" gathers every unfinished item from every CONCEPT list into a new
 * one, keeping the slugs, so a reel that died at its last step re-joins in seconds.
 */
import { readBatch, resumeBatch, retryAllFailed, stopBatch } from "@/lib/reels-batch";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await request.json() as { id?: string; action?: string };
    const id = String(body.id ?? "");

    if (body.action === "stop") {
      await stopBatch(id);
    } else if (body.action === "resume") {
      await resumeBatch(id);
    } else if (body.action === "retry-all") {
      const made = await retryAllFailed("concept");
      return Response.json({ ...made, batch: await readBatch(made.id) });
    } else {
      return Response.json({ error: "Unknown action." }, { status: 400 });
    }
    return Response.json({ batch: await readBatch(id) });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "That did not work.";
    return Response.json({ error: message }, { status: 400 });
  }
}
