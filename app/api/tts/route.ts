/** Speak a line of English in one of four accents, for scripts and other programs to call.
 *
 * This is a thin door onto the voice service on 8200. The models themselves cannot live in this
 * process, or even in one Python process: the three engines behind these four voices need
 * mutually incompatible versions of transformers, so each runs in its own venv as a child of
 * that service. All this route does is pass the request along and hand back the audio.
 *
 *   POST /api/tts  {"voice": "middle_eastern", "text": "..."}   -> audio/wav
 *   GET  /api/tts                                               -> the voices you can ask for
 *
 * Timeouts are generous on purpose. Only one voice engine is held in memory at a time, so a
 * request that switches engines pays a model load first -- about a minute in the worst case,
 * a few seconds when the same voice was used recently.
 */
export const dynamic = "force-dynamic";

const VOICE_API = process.env.VOICE_API_URL ?? "http://127.0.0.1:8200";
const TIMEOUT_MS = 300_000;

type SpeakBody = {
  voice?: string; text?: string; gender?: string; seed?: number; keep?: boolean;
};

function down(caught: unknown) {
  return Response.json({
    error: "The voice service is not answering.",
    hint: `Expected it at ${VOICE_API}. It is started by scripts/start-voice-api.ps1 and by the ` +
          `VoiceApiStart scheduled task; the watchdog puts it back within a few minutes.`,
    detail: caught instanceof Error ? caught.message : String(caught),
  }, { status: 503, headers: { "cache-control": "no-store" } });
}

export async function GET() {
  try {
    const response = await fetch(`${VOICE_API}/voices`, { signal: AbortSignal.timeout(10_000) });
    const voices = await response.json();
    return Response.json({
      usage: {
        method: "POST",
        url: "/api/tts",
        body: {
          voice: "an accent below, or an accent_gender name",
          text: "what to say",
          gender: "optional, male or female",
          seed: "optional, default 1234",
        },
        returns: "audio/wav bytes; pass keep:true instead to get JSON with a path on disk",
      },
      voices,
    }, { headers: { "cache-control": "no-store" } });
  } catch (caught) {
    return down(caught);
  }
}

export async function POST(request: Request) {
  let body: SpeakBody;
  try {
    body = await request.json() as SpeakBody;
  } catch {
    return Response.json({ error: "Send JSON with a voice and some text." }, { status: 400 });
  }

  const voice = (body.voice ?? "").trim();
  const text = (body.text ?? "").trim();
  if (!voice || !text) {
    return Response.json({
      error: "Both 'voice' and 'text' are required.",
      example: { voice: "middle_eastern", text: "Hello, this is a test." },
    }, { status: 400 });
  }

  try {
    const response = await fetch(`${VOICE_API}/tts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        voice, text, gender: body.gender ?? null,
        seed: body.seed ?? 1234, keep: body.keep ?? false,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    // Errors come back as JSON from the service; pass them through rather than flattening them,
    // because "the GPU is busy rendering a film" is a different problem from "no such voice".
    if (!response.ok) {
      const detail = await response.json().catch(() => ({ error: "voice service failed" }));
      return Response.json(detail, { status: response.status, headers: { "cache-control": "no-store" } });
    }

    const contentType = response.headers.get("content-type") ?? "application/octet-stream";
    if (contentType.includes("application/json")) {
      return Response.json(await response.json(), { headers: { "cache-control": "no-store" } });
    }

    return new Response(response.body, {
      headers: {
        "content-type": "audio/wav",
        "cache-control": "no-store",
        "x-voice": response.headers.get("x-voice") ?? voice,
        "x-accent": response.headers.get("x-accent") ?? "",
        "x-gender": response.headers.get("x-gender") ?? "",
        "x-engine": response.headers.get("x-engine") ?? "",
        "x-audio-seconds": response.headers.get("x-audio-seconds") ?? "",
        "x-generation-seconds": response.headers.get("x-generation-seconds") ?? "",
      },
    });
  } catch (caught) {
    return down(caught);
  }
}
