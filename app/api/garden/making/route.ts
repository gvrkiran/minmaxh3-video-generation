/**
 * The reels being made right now, for the home screen.
 *
 * Deliberately not folded into `/api/garden/library`. That one probes every finished reel for
 * its duration and generates any missing poster, which over two hundred reels is slow and is
 * fine because the shelf changes rarely. This is polled every few seconds while the home
 * screen is open, so it does the cheap work only: a reel with a finished cut is skipped on one
 * stat, and only the handful still going cost anything to describe.
 */
import { listMaking } from "@/lib/reels-runner";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return Response.json({ items: await listMaking("garden") });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "Could not check what is being made.";
    // An empty list rather than a bare error: the home screen shows this above the shelf, and
    // losing the shelf because a progress poll failed would be the worse trade.
    return Response.json({ error: message, items: [] }, { status: 500 });
  }
}
