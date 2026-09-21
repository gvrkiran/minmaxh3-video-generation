/**
 * Stop a running list, or set it going again.
 *
 * Both are one POST with an `action`, because they are the same button in two states and
 * splitting them across two routes would only mean two places to keep the guards in step.
 *
 * "Resume" covers three situations that look different on the screen and are identical
 * underneath -- the machine rebooted mid-list, someone pressed stop and changed their mind,
 * and two ideas failed and deserve another try. In every case the driver skips what is
 * finished and redoes only what is missing, so there is no separate per-list "retry".
 *
 * "retry-all" is the one thing resume cannot do: failures scatter across lists, and resume
 * reaches inside only one. It takes no id, gathers every unfinished item from every list into
 * a new one, and returns that.
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
      // Gathers across every gardening list, so it takes no id and returns the new list it
      // made. The painting page retries its own.
      const made = await retryAllFailed("garden");
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
