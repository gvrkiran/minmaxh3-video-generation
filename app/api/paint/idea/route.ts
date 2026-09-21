/**
 * "Surprise me" and "Suggest ideas": new painting ideas from the model, none already made here.
 *
 * The model is given everything this lab has painted or queued (read from disk by
 * `suggest_ideas.py`) plus whatever the page sends in `avoid`, and asked for ideas inside the
 * brief -- Indian, faceless, about the material -- that repeat none of it.
 *
 * If the model cannot be reached the response still carries ideas, from the built-in lists,
 * and says so with `source: "local"`: a button that does nothing is worse than a plainer idea,
 * but a plainer idea passed off as the model's would be worse again, so the page shows a note.
 */
import { suggestIdeas } from "@/lib/reels-runner";
import { suggestIdeas as localIdeas } from "@/lib/paint-ideas";

export const dynamic = "force-dynamic";
// One low-effort model call, normally 5-20 s; the module's own ceiling is 150 s.
export const maxDuration = 300;

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as { count?: number; avoid?: unknown };
  const count = Math.max(1, Math.min(25, Math.floor(Number(body.count ?? 1)) || 1));
  const avoid = Array.isArray(body.avoid)
    ? body.avoid.map((a) => String(a ?? "").trim()).filter(Boolean).slice(0, 200)
    : [];

  try {
    const ideas = await suggestIdeas("paint", count, avoid);
    if (!ideas.length) throw new Error("The model returned no usable idea.");
    return Response.json({ ideas, source: "model" });
  } catch (caught) {
    const detail = caught instanceof Error ? caught.message : "The idea model could not be reached.";
    return Response.json({ ideas: localIdeas(count), source: "local", detail });
  }
}
