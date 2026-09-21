/** Everything finished, for the shelf on the home screen.
 *
 * Also generates any missing poster stills on first call, which is why this is not cached:
 * one ffmpeg frame-grab per new reel, then never again.
 */
import { listLibrary } from "@/lib/reels-runner";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    // Gardening reels only; the painting reels have their own shelf on /paint.
    return Response.json({ items: await listLibrary("garden") });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "Could not read the library.";
    return Response.json({ error: message, items: [] }, { status: 500 });
  }
}
