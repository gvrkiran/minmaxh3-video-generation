/**
 * Screen 1 -> 2: turn one typed concept into a plan she can check before any GPU is spent.
 *
 * The model's first job in this genre is to improve the concept -- pick the angle, choose the
 * thread that holds the shots together -- and that decision comes back in the plan's
 * `understood`, in two or three sentences, which is what the plan screen puts first.
 */
import { writePlan } from "@/lib/reels-runner";

export const dynamic = "force-dynamic";
// The model call is pinned to low reasoning effort and normally lands in 15-40s, but the
// route must not be cut off before the module's own 420s ceiling.
export const maxDuration = 600;

export async function POST(request: Request) {
  try {
    const body = await request.json() as { concept?: string; idea?: string; tip?: string };
    const concept = String(body.concept ?? body.idea ?? body.tip ?? "").trim();

    // A concept can be two words -- "compound interest" -- so the floor is low.
    if (concept.length < 3) {
      return Response.json(
        { error: "Write a few words about what the video should be about." },
        { status: 400 });
    }
    // Longer than the painting page allows, deliberately: a rough paragraph is a legitimate
    // way to hand over a concept, and improving it is the model's job. Past this it is a
    // document, and a slow expensive way to get a muddled reel.
    if (concept.length > 1500) {
      return Response.json(
        { error: "That is a bit long. A few sentences about one concept works best." },
        { status: 400 });
    }

    return Response.json({ plan: await writePlan(concept, "concept") });
  } catch (caught) {
    const detail = caught instanceof Error ? caught.message : "The plan could not be written.";
    // Deliberately two fields. She reads `error`; whoever fixes it reads `detail`, which
    // carries the validator's actual complaints from write_reel.py.
    return Response.json({
      error: "Could not plan the video. Please try again, or say the concept a different way.",
      detail,
    }, { status: 500 });
  }
}
