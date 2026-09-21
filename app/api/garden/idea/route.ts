/**
 * "Surprise me": one gardening idea nobody here has been given before.
 *
 * The model is handed everything this lab has made or been asked to make -- read off disk by
 * `suggest_ideas.py` -- plus whatever the page sends in `avoid`, which is the only part it
 * cannot know: the line already in the box, and anything it has already offered this sitting.
 *
 * `lang` is the language of the IDEA, not of the page. /garden opens in Telugu and this goes
 * straight into a box its reader then edits, so in Telugu it has to come back in Telugu script.
 *
 * NO LOCAL FALLBACK, unlike the painting side. There a fixed list of subjects and mediums can
 * pair up into a passable idea; a gardening tip cannot be assembled from lists without either
 * inventing a practice that does not work or repeating one of the two hundred already made.
 * A plain "could not think of one, try again" is the honest answer, and the box still takes
 * whatever she types herself.
 */
import { suggestIdeas } from "@/lib/reels-runner";

export const dynamic = "force-dynamic";
// One low-effort call, normally 5-20s; the module's own ceiling covers its novelty retries.
export const maxDuration = 300;

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({})) as { lang?: string; avoid?: unknown };
    const lang = body.lang === "en" ? "en" : "te";
    const avoid = Array.isArray(body.avoid)
      ? body.avoid.map((a) => String(a ?? "").trim()).filter(Boolean).slice(0, 50)
      : [];

    const ideas = await suggestIdeas("garden", 1, avoid, lang);
    const idea = ideas[0]?.trim();
    if (!idea) throw new Error("The model returned no usable idea.");
    return Response.json({ idea });
  } catch (caught) {
    const detail = caught instanceof Error ? caught.message : "No idea came back.";
    // Two fields on purpose. She reads `error`; whoever fixes it reads `detail`, which carries
    // the module's own complaints -- every one names either a repeat or a rule it broke.
    return Response.json({
      error: "Could not think of a new one just now. Please try again.",
      detail,
    }, { status: 500 });
  }
}
