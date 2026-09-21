/** Polled every few seconds while screen 3 is open. Reads the filesystem, not a status file. */
import { readReelProgress } from "@/lib/reels-runner";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const slug = new URL(request.url).searchParams.get("slug");
    return Response.json(await readReelProgress(String(slug ?? "")));
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "Could not check progress.";
    return Response.json({ error: message }, { status: 500 });
  }
}
