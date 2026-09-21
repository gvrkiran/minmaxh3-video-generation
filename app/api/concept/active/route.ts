/**
 * Everything being made right now, for the "being made now" shelf on /concept.
 *
 * Reels that have started rendering (a render.log under `user/<slug>/`, read by `listActive`),
 * plus items of a live concept list should one ever exist -- the batch driver already writes
 * the kind onto every item, so this costs nothing to support. Polled every few seconds while
 * the home screen is open, so it reads the filesystem and nothing else.
 */
import { listActive, type ActiveReel } from "@/lib/reels-runner";
import { activeBatch } from "@/lib/reels-batch";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const items = await listActive("concept");

    // Per item, not per list: lines can be added to whichever list is running, so a concept
    // may be queued inside a list that began as paintings.
    const batch = await activeBatch().catch(() => null);
    if (batch) {
      const seen = new Set(items.map((i) => i.slug));
      for (const item of batch.items) {
        if ((item.kind ?? batch.kind ?? "garden") !== "concept") continue;
        if (seen.has(item.slug)) continue;
        if (item.status !== "pending" && item.status !== "planning") continue;
        const queued: ActiveReel = {
          slug: item.slug, kind: "concept",
          titleTe: item.titleTe, titleEn: item.titleEn, idea: item.idea,
          stage: "waiting",
          label: item.status === "planning" ? "Writing the plan" : "Waiting in the list",
          shotsDone: 0, shotsTotal: 0, minutesLeft: null, failed: null,
          updatedAt: item.startedAt ?? batch.createdAt,
        };
        items.push(queued);
      }
    }

    return Response.json({ items });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "Could not read what is being made.";
    return Response.json({ error: message, items: [] }, { status: 500 });
  }
}
