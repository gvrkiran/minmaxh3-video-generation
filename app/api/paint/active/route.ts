/**
 * Everything being made right now, for the "being made now" shelf on /paint.
 *
 * Two sources, because a video can be in progress before it has a folder of its own: reels
 * that have started rendering (a render.log under `user/<slug>/`, read by `listActive`), and
 * items of a live painting list that are still waiting their turn or having their plan
 * written -- those exist only in batch.json until the driver reaches them. Polled every few
 * seconds while the home screen is open, so it reads the filesystem and nothing else.
 */
import { listActive, type ActiveReel } from "@/lib/reels-runner";
import { activeBatch } from "@/lib/reels-batch";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const items = await listActive("paint");

    // Per item, not per list: lines can be added to whichever list is running, so a painting
    // may be queued inside a list that began as something else.
    const batch = await activeBatch().catch(() => null);
    if (batch) {
      const seen = new Set(items.map((i) => i.slug));
      for (const item of batch.items) {
        if ((item.kind ?? batch.kind ?? "garden") !== "paint") continue;
        if (seen.has(item.slug)) continue;
        if (item.status !== "pending" && item.status !== "planning") continue;
        const queued: ActiveReel = {
          slug: item.slug, kind: "paint",
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
