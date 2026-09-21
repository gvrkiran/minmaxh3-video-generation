/**
 * The voice-over script of one reel: the lines in both languages, the window each has in the
 * finished video, and which cuts exist -- including the one with no voice on it.
 *
 *   GET /api/concept/script?slug=concept-...              JSON, for the page
 *   GET /api/concept/script?slug=...&format=txt           one text file to read from
 *   GET /api/concept/script?slug=...&format=srt&lang=te   subtitles, one cue per shot
 *
 * The JSON call also makes the no-voice cut if the shots exist and it does not yet -- a few
 * seconds of ffmpeg, once per reel, cached beside the video -- so by the time the download
 * button is visible the file behind it is there. That is why this route is allowed a while.
 *
 * Works from the plan onwards: a reel that has only been planned answers with its lines and
 * no windows, so the plan can be read before anything is spent on it.
 */
import { readReelScript, scriptAsSrt, scriptAsText } from "@/lib/reels-script";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const format = params.get("format") ?? "json";
  const lang = params.get("lang") === "en" ? "en" : "te";
  try {
    const script = await readReelScript(String(params.get("slug") ?? ""));

    if (format === "txt") {
      return new Response(scriptAsText(script), {
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "content-disposition": `attachment; filename="${script.slug}_script.txt"`,
          "cache-control": "no-store",
        },
      });
    }
    if (format === "srt") {
      if (!script.timed) {
        return Response.json(
          { error: "The windows are not known until the video has been made." },
          { status: 409 });
      }
      return new Response(scriptAsSrt(script, lang), {
        headers: {
          "content-type": "application/x-subrip; charset=utf-8",
          "content-disposition": `attachment; filename="${script.slug}_${lang}.srt"`,
          "cache-control": "no-store",
        },
      });
    }
    return Response.json(script, { headers: { "cache-control": "no-store" } });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "Could not read the script.";
    return Response.json({ error: message }, { status: 404 });
  }
}
