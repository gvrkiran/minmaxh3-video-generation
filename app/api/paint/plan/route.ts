/** Screen 1 -> 2: turn one typed painting idea into a plan she can check before any GPU is spent. */
import { writePlan } from "@/lib/reels-runner";

export const dynamic = "force-dynamic";
// The model call is pinned to low reasoning effort and normally lands in 15-40s, but the
// route must not be cut off before the module's own 420s ceiling.
export const maxDuration = 600;

export async function POST(request: Request) {
  try {
    const body = await request.json() as { idea?: string; tip?: string };
    const idea = String(body.idea ?? body.tip ?? "").trim();

    // A painting idea can legitimately be one word -- "kingfisher" -- so the floor is low.
    // The garden's ten-character floor exists because a tip shorter than that is not a tip.
    if (idea.length < 2) {
      return Response.json(
        { error: "Write a word or two about the painting, or press Surprise me." },
        { status: 400 });
    }
    // Guards the model call, not the disk: a novel pasted into the box is a slow expensive
    // way to get a bad reel.
    if (idea.length > 600) {
      return Response.json(
        { error: "That is a bit long. One painting at a time works best." }, { status: 400 });
    }

    return Response.json({ plan: await writePlan(idea, "paint") });
  } catch (caught) {
    const detail = caught instanceof Error ? caught.message : "The plan could not be written.";
    // Deliberately two fields. She reads `error`; whoever fixes it reads `detail`, which
    // carries the validator's actual complaints from write_reel.py.
    return Response.json({
      error: "Could not plan the painting. Please try again, or say the idea a different way.",
      detail,
    }, { status: 500 });
  }
}
