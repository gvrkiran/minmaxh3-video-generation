/** Screen 1 -> 2: turn one typed tip into a plan she can check before any GPU is spent. */
import { writePlan } from "@/lib/reels-runner";

export const dynamic = "force-dynamic";
// The model call is pinned to low reasoning effort and normally lands in 15-40s, but the
// route must not be cut off before the module's own 420s ceiling.
export const maxDuration = 600;

export async function POST(request: Request) {
  try {
    const body = await request.json() as { tip?: string };
    const tip = String(body.tip ?? "").trim();

    if (tip.length < 10) {
      return Response.json(
        { error: "Please write a little more about the tip." }, { status: 400 });
    }
    // Guards the model call, not the disk: a novel pasted into the box is a slow expensive
    // way to get a bad three-shot reel.
    if (tip.length > 600) {
      return Response.json(
        { error: "That is a bit long. One tip at a time works best." }, { status: 400 });
    }

    return Response.json({ plan: await writePlan(tip) });
  } catch (caught) {
    const detail = caught instanceof Error ? caught.message : "The plan could not be written.";
    // Deliberately two fields. She reads `error`; whoever fixes it reads `detail`, which
    // carries the validator's actual complaints from write_reel.py.
    return Response.json({
      error: "Could not write the plan. Please try again, or say the tip a different way.",
      detail,
    }, { status: 500 });
  }
}
