/** Every finished concept reel, for the shelf on the home screen.
 *
 * Only the concept ones: each page shows its own shelf, and the filter runs before the
 * per-reel probe so two hundred reels of the other kinds cost this page nothing. Also
 * generates any missing poster stills on first call, which is why this is not cached.
 */
import { listLibrary } from "@/lib/reels-runner";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return Response.json({ items: await listLibrary("concept") });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "Could not read the library.";
    return Response.json({ error: message, items: [] }, { status: 500 });
  }
}
