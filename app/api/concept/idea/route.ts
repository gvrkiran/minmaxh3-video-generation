/**
 * "Surprise me": a few concepts from the model that nobody here has made, in the box's language.
 *
 * The model is given everything this lab has made or been asked to make (read from disk by
 * `suggest_ideas.py`) plus whatever the page sends in `avoid` -- the lines already in the box
 * and the ones offered earlier this sitting -- and asked for ideas inside the brief: everyday
 * Indian life, tellable without a face or writing on screen, none of them a repeat.
 *
 * `lang` is the language of the IDEAS, not of the page. They land in a box the reader then
 * edits, so in Telugu they have to come back in Telugu script.
 *
 * If the model cannot be reached the response still carries ideas, from the built-in list, and
 * says so with `source: "local"`: a button that does nothing is worse than a plainer idea, but
 * a plainer idea passed off as the model's would be worse again, so the page shows a note.
 */
import { suggestIdeas } from "@/lib/reels-runner";
import { surpriseIdeas as localIdeas } from "@/lib/concept-ideas";

export const dynamic = "force-dynamic";
// One low-effort model call, normally 5-20 s, with the module's novelty retries on top.
export const maxDuration = 300;

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as {
    count?: number; lang?: string; avoid?: unknown;
  };
  const count = Math.max(1, Math.min(10, Math.floor(Number(body.count ?? 3)) || 3));
  const lang = body.lang === "en" ? "en" : "te";
  const avoid = Array.isArray(body.avoid)
    ? body.avoid.map((a) => String(a ?? "").trim()).filter(Boolean).slice(0, 200)
    : [];

  try {
    const ideas = await suggestIdeas("concept", count, avoid, lang);
    if (!ideas.length) throw new Error("The model returned no usable idea.");
    return Response.json({ ideas, source: "model" });
  } catch (caught) {
    const detail = caught instanceof Error ? caught.message : "The idea model could not be reached.";
    return Response.json({ ideas: localIdeas(count, lang), source: "local", detail });
  }
}
