import { castBoardPosition, neutralizeReferenceCharacterNames } from "@/lib/reference-prompt";

const SUPPORTED_LANGUAGES = [
  "Assamese",
  "Bengali",
  "Gujarati",
  "Hindi",
  "Kannada",
  "Malayalam",
  "Marathi",
  "Odia",
  "Punjabi",
  "Tamil",
  "Telugu",
];

type GeminiPayload = {
  videoPrompt?: unknown;
  narrationText?: unknown;
  narrationLanguage?: unknown;
  narrationSupported?: unknown;
  narrationReason?: unknown;
  narrationMode?: unknown;
  narrationSegments?: unknown;
};

type GeminiSegment = {
  speaker?: unknown;
  voice?: unknown;
  language?: unknown;
  startSeconds?: unknown;
  endSeconds?: unknown;
  text?: unknown;
};

function cleanString(value: unknown, maximum: number) {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const prompt = cleanString(body.prompt, 8_000);
    const apiKey = cleanString(process.env.GEMINI_API_KEY, 512);
    const duration = Math.max(3, Math.min(12, Number(body.duration) || 5));
    const aspect = cleanString(body.aspect, 12) || "16:9";
    const mode = body.mode === "i2v" ? "image-to-video" : body.mode === "r2v" ? "reference-to-video" : "text-to-video";
    const characters = Array.isArray(body.characters) ? body.characters.slice(0, 9).flatMap((item, index) => {
      if (!item || typeof item !== "object") return [];
      const entry = item as Record<string, unknown>;
      const name = cleanString(entry.name, 80);
      if (!name) return [];
      return [{ tag: `<Picture ${index + 1}>`, name, description: cleanString(entry.description, 500) }];
    }) : [];
    const castBoardMode = characters.length > 1;
    const referenceBrief = characters.length
      ? castBoardMode
        ? `\nREFERENCE CAST BOARD (binding): The app combines the selected images into one <Picture 1>. Define one Subject per cast member by position.\n${characters.map((character, index) => `- <Subject ${index + 1}> is the ${castBoardPosition(index, characters.length)} character in <Picture 1>. Planning name: ${character.name}. ${character.description || "Preserve this character's exact identity, face, body proportions, hair, costume, colors, and rendering style."}`).join("\n")}\n`
        : `\nREFERENCE CAST (the order is binding):\n${characters.map((character) => `- ${character.tag}: ${character.name}. ${character.description || "Preserve this character's exact identity, face, body proportions, hair, costume, colors, and rendering style."}`).join("\n")}\n`
      : "";

    if (!prompt) return Response.json({ error: "Add a prompt before asking Gemini to enhance it." }, { status: 400 });
    if (!apiKey) return Response.json({ error: "The server-side Gemini credential is not configured." }, { status: 503 });

    const targetWords = Math.max(4, Math.floor(duration * 1.9));
    const directorBrief = `You are a precise film director, dialogue editor, and casting director preparing a MiniMax H3 video and a timed AI4Bharat IndicF5 dialogue track.

USER IDEA:
${prompt}

PRODUCTION SETTINGS:
- Mode: ${mode}
- Aspect ratio: ${aspect}
- Exact video duration: ${duration} seconds
- Approximate total speech budget: ${targetWords} words, adjusted naturally for the selected language
${referenceBrief}

TASK:
1. Rewrite the user's idea as a single production-ready MiniMax H3 prompt in English. Preserve every important fact and the user's intent. Add concrete subject appearance, environment, blocking, action, temporal progression across the ${duration}-second shot, camera lens/framing/movement, lighting, color, realistic motion and physics, facial consistency, sound design, and a concise negative constraint section. For every spoken line, explicitly identify who speaks and the matching time window so lip movement, listening reactions, and turn-taking are coherent. Do not claim impossible resolution such as 8K. Do not add scene cuts unless the user asks for them. For image-to-video, explicitly preserve the reference image's identity, wardrobe, composition, and first-frame geometry. For reference-to-video, follow the mandatory full-reference structure below and prohibit face, costume, body, or style drift and identity blending between characters.
2. Detect any spoken-language request in the idea. IndicF5 officially supports only: ${SUPPORTED_LANGUAGES.join(", ")}.
3. If the idea requests dialogue, narration, talking, speaking, or a voiceover, return an ordered narrationSegments timeline. Use one segment per uninterrupted utterance. Each segment must contain a stable character name, the exact words in native script, language, startSeconds, endSeconds, and a voice value of male or female matching that character's gender presentation in the user's idea. Give different male and female characters their matching distinct built-in voices. Preserve the same voice assignment every time a character speaks. Never merge a man's and woman's lines into one segment.
4. Segments must be chronological, must not overlap, must remain inside 0–${duration} seconds, and must leave natural pauses between speakers. Each window should be long enough for comfortable speech; shorten the words rather than making speech unnaturally fast. Use no more than 12 segments. Put no stage directions in segment text.
5. Use narrationMode dialogue when two or more characters speak, single when one character or narrator speaks, and none when no speech is requested. narrationText should contain the full readable script, with speaker labels for dialogue, while segment text contains only spoken words. If the user explicitly requests no speech, return empty narrationText, an empty segment array, and mode none. If the requested language is unsupported, still write the requested script but set narrationSupported false.
6. If a supported language is not named, infer it only when culturally and linguistically clear; otherwise use Hindi. Do not translate names, factual claims, or culturally specific details unnecessarily. Do not invent quotations attributed to real people. Do not add a narrator unless the user asks for one or the idea is explicitly a voiceover.

REFERENCE-TO-VIDEO FORMAT (mandatory when Mode is reference-to-video):
- Character names in REFERENCE CAST are planning metadata for you and labels for the separate TTS plan. NEVER put those names in the English videoPrompt because names such as famous, mythological, or historical figures activate model priors and override the supplied image. Preserve a name only when it is literally spoken inside a non-English <d> dialogue tag. In all other videoPrompt prose, use only <Subject N>.
- Begin videoPrompt with subject_definitions:. ${castBoardMode ? "All cast members come from the single <Picture 1> cast board. Define <Subject N> as the character at the supplied board position in <Picture 1>; do not invent <Picture 2> or later Picture labels." : "Define the reusable visual subject exactly as <Subject 1> is the character in <Picture 1>."} Follow each definition with the supplied visible identity/style notes. Treat the picture as the sole source of appearance. Never infer culturally associated crowns, clothing, jewelry, weapons, skin tones, or realism.
- Then write summary: beginning with [reference generation].
- Then write retention_analysis:. Use the exact official syntax for every subject: <Subject N> (appears in [Shot 1]): fully_preserved - DESCRIPTION. Explicitly lock face, skin tone, hair, headwear, costume, colors, body proportions, and illustration/rendering style. Explicitly prohibit unreferenced crowns, jewelry, clothing, weapons, and photographic restyling.
- Then write detailed_description:. Establish the visual style, then begin the continuous shot with [Shot 1]. Use <Subject N>—not <Picture N>—for every visible character. Do not put character names in parentheses after Subject tags.
- Every physical speaker needs a stable speaker ID in order of first speech: <Subject N> (S1), <Subject N> (S2), and so on. Every spoken line must use the exact MiniMax dialogue form <d>[Language] exact native-script words.</d>. Never use quotation marks for dialogue. Mention the lip closure and listener reaction after each line.
- End with overall_soundscape: and non_diegetic_music:. Do not include or define characters the user's idea does not actually use.

Return only the requested structured result.`;

    const model = process.env.GEMINI_MODEL?.trim() || "gemini-3.6-flash";
    const geminiResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: directorBrief }] }],
          generationConfig: {
            responseMimeType: "application/json",
            responseJsonSchema: {
              type: "object",
              additionalProperties: false,
              properties: {
                videoPrompt: { type: "string", description: "Detailed production-ready MiniMax H3 prompt in English." },
                narrationText: { type: "string", description: "Exact spoken text in the requested language and native script, or an empty string." },
                narrationLanguage: { type: "string", description: "Requested or inferred spoken language, or None." },
                narrationSupported: { type: "boolean", description: "Whether IndicF5 officially supports the narration language." },
                narrationReason: { type: "string", description: "Short explanation of the language and timing choice." },
                narrationMode: { type: "string", enum: ["none", "single", "dialogue"], description: "Whether the plan has no speech, one voice, or multiple speaking characters." },
                narrationSegments: {
                  type: "array",
                  maxItems: 12,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      speaker: { type: "string", description: "Stable character name or Narrator." },
                      voice: { type: "string", enum: ["male", "female"], description: "Built-in IndicF5 voice matching this character." },
                      language: { type: "string", description: "Spoken language." },
                      startSeconds: { type: "number", description: "Start time in seconds." },
                      endSeconds: { type: "number", description: "End time in seconds." },
                      text: { type: "string", description: "Only the exact spoken words in native script." },
                    },
                    required: ["speaker", "voice", "language", "startSeconds", "endSeconds", "text"],
                  },
                },
              },
              required: ["videoPrompt", "narrationText", "narrationLanguage", "narrationSupported", "narrationReason", "narrationMode", "narrationSegments"],
            },
          },
        }),
        signal: AbortSignal.timeout(90_000),
      },
    );

    if (!geminiResponse.ok) {
      if (geminiResponse.status === 401 || geminiResponse.status === 403) {
        return Response.json({ error: "Gemini rejected the server credential. Check the key in Google AI Studio." }, { status: 401 });
      }
      if (geminiResponse.status === 400) {
        return Response.json({ error: "Gemini could not process this enhancement request. Try simplifying the prompt." }, { status: 400 });
      }
      if (geminiResponse.status === 429) {
        return Response.json({ error: "Gemini's quota is temporarily exhausted. Wait a moment and try again." }, { status: 429 });
      }
      throw new Error(`Gemini returned HTTP ${geminiResponse.status}.`);
    }

    const envelope = await geminiResponse.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const responseText = envelope.candidates?.[0]?.content?.parts
      ?.map((part) => part.text || "")
      .join("")
      .trim();
    if (!responseText) throw new Error("Gemini did not return an enhanced prompt.");

    const result = JSON.parse(responseText) as GeminiPayload;
    let videoPrompt = cleanString(result.videoPrompt, 12_000);
    if (mode === "reference-to-video" && characters.length) {
      videoPrompt = neutralizeReferenceCharacterNames(videoPrompt, characters.map((character) => character.name));
    }
    const narrationText = cleanString(result.narrationText, 3_000);
    const narrationLanguage = cleanString(result.narrationLanguage, 80) || "None";
    const narrationReason = cleanString(result.narrationReason, 400);
    const narrationMode = result.narrationMode === "dialogue" || result.narrationMode === "single" ? result.narrationMode : "none";
    const narrationSegments = Array.isArray(result.narrationSegments)
      ? (result.narrationSegments as GeminiSegment[]).map((segment) => ({
          speaker: cleanString(segment.speaker, 80),
          voice: segment.voice === "male" ? "male" as const : "female" as const,
          language: cleanString(segment.language, 80) || narrationLanguage,
          startSeconds: Math.max(0, Math.min(duration, Number(segment.startSeconds) || 0)),
          endSeconds: Math.max(0, Math.min(duration, Number(segment.endSeconds) || 0)),
          text: cleanString(segment.text, 1_000),
        })).filter((segment) => segment.speaker && segment.text && segment.endSeconds > segment.startSeconds)
          .sort((a, b) => a.startSeconds - b.startSeconds)
      : [];
    if (!videoPrompt) throw new Error("Gemini returned an empty video prompt.");

    return Response.json({
      videoPrompt,
      narrationText,
      narrationLanguage,
      narrationSupported: result.narrationSupported === true,
      narrationReason,
      narrationMode,
      narrationSegments,
      model,
    });
  } catch (caught) {
    const message = caught instanceof Error && caught.name === "TimeoutError"
      ? "Gemini took too long to respond. Try again."
      : caught instanceof Error ? caught.message : "Could not enhance the prompt.";
    return Response.json({ error: message }, { status: 500 });
  }
}
