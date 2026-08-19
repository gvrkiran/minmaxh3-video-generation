import { buildWorkflow, comfyFetch, GenerationMode, NarrationSegment } from "@/lib/comfy";
import { getCharacter } from "@/lib/characters";
import { castBoardPosition, neutralizeReferenceCharacterNames } from "@/lib/reference-prompt";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const runtimeRequire = createRequire(import.meta.url);

const OUTPUT_ROOT = process.env.COMFY_OUTPUT_ROOT ?? "C:\\Users\\kg766\\Downloads\\ComfyUI\\output";

async function uploadComfyImage(image: File, fallbackName: string) {
  const upload = new FormData();
  upload.set("image", image, image.name || fallbackName);
  upload.set("type", "input");
  upload.set("overwrite", "true");
  const uploaded = await (await comfyFetch("/upload/image", { method: "POST", body: upload })).json() as { name: string; subfolder?: string };
  return uploaded.subfolder ? `${uploaded.subfolder}/${uploaded.name}` : uploaded.name;
}

async function createCastBoard(imagePaths: string[]) {
  const sharpModuleName = process.env.SHARP_MODULE_NAME || "sharp";
  const sharp = runtimeRequire(sharpModuleName) as typeof import("sharp");
  const columns = imagePaths.length <= 3 ? imagePaths.length : imagePaths.length === 4 ? 2 : 3;
  const rows = Math.ceil(imagePaths.length / columns);
  const panelWidth = 512;
  const panelHeight = 768;
  const background = { r: 234, g: 216, b: 189 };
  const panels = await Promise.all(imagePaths.map((imagePath) => sharp(imagePath)
    .resize(panelWidth, panelHeight, { fit: "contain", background })
    .png()
    .toBuffer()));
  return sharp({
    create: {
      width: columns * panelWidth,
      height: rows * panelHeight,
      channels: 3,
      background,
    },
  }).composite(panels.map((input, index) => ({
    input,
    left: (index % columns) * panelWidth,
    top: Math.floor(index / columns) * panelHeight,
  }))).png().toBuffer();
}

function parseNarrationSegments(value: FormDataEntryValue | null, duration: number) {
  if (typeof value !== "string" || !value.trim()) return [];
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || parsed.length > 12) throw new Error("The speaker plan is invalid.");

  const segments: NarrationSegment[] = parsed.map((item, index) => {
    if (!item || typeof item !== "object") throw new Error(`Speaker line ${index + 1} is invalid.`);
    const entry = item as Record<string, unknown>;
    const speaker = String(entry.speaker ?? "").trim().slice(0, 80);
    const voice = entry.voice === "male" ? "male" : entry.voice === "female" ? "female" : null;
    const language = String(entry.language ?? "").trim().slice(0, 80);
    const text = String(entry.text ?? "").trim().slice(0, 1_000);
    const startSeconds = Number(entry.startSeconds);
    const endSeconds = Number(entry.endSeconds);
    if (!speaker || !voice || !text || !Number.isFinite(startSeconds) || !Number.isFinite(endSeconds)) {
      throw new Error(`Speaker line ${index + 1} is incomplete.`);
    }
    if (startSeconds < 0 || endSeconds <= startSeconds || endSeconds > duration + 0.05) {
      throw new Error(`Speaker line ${index + 1} falls outside the ${duration}-second video.`);
    }
    return { speaker, voice, language, startSeconds, endSeconds, text };
  }).sort((a, b) => a.startSeconds - b.startSeconds);

  for (let index = 1; index < segments.length; index += 1) {
    if (segments[index].startSeconds < segments[index - 1].endSeconds - 0.02) {
      throw new Error(`Speaker lines ${index} and ${index + 1} overlap.`);
    }
  }
  return segments;
}

export async function POST(request: Request) {
  try {
    const data = await request.formData();
    const requestedMode = String(data.get("mode") ?? "t2v");
    const mode: GenerationMode = requestedMode === "i2v" ? "i2v" : requestedMode === "r2v" ? "r2v" : "t2v";
    let prompt = String(data.get("prompt") ?? "").trim();
    const originalPrompt = String(data.get("originalPrompt") ?? prompt).trim().slice(0, 8_000);
    const promptEnhanced = data.get("promptEnhanced") === "true";
    if (!prompt) return Response.json({ error: "Add a direction before generating." }, { status: 400 });

    let imageName: string | undefined;
    if (mode === "i2v") {
      const image = data.get("image");
      if (!(image instanceof File) || !image.type.startsWith("image/")) {
        return Response.json({ error: "A valid starting image is required." }, { status: 400 });
      }
      imageName = await uploadComfyImage(image, `frame-${Date.now()}.png`);
    }

    const referenceImageNames: string[] = [];
    let r2vCharacterCount = 0;
    if (mode === "r2v") {
      let characterIds: string[] = [];
      try {
        const parsed = JSON.parse(String(data.get("characterIds") ?? "[]")) as unknown;
        if (Array.isArray(parsed)) characterIds = parsed.map(String).slice(0, 9);
      } catch {
        characterIds = [];
      }
      if (characterIds.length === 0) {
        return Response.json({ error: "Select at least one saved character for reference-to-video." }, { status: 400 });
      }
      r2vCharacterCount = characterIds.length;
      const castBoardMode = characterIds.length > 1 && data.get("referenceLayout") !== "separate";

      const usedPictureNumbers = [...new Set(
        [...prompt.matchAll(/<Picture\s+(\d+)>/giu)]
          .map((match) => Number(match[1]))
          .filter((number) => Number.isInteger(number)),
      )].sort((a, b) => a - b);
      const promptUsesPictureTags = usedPictureNumbers.length > 0;
      if (castBoardMode && usedPictureNumbers.some((number) => number !== 1)) {
        return Response.json({
          error: "Multiple selected characters use one automatic cast board: <Picture 1>. Refer to the people as <Subject 1>, <Subject 2>, and so on, or leave Gemini enhancement enabled so this is written automatically.",
        }, { status: 400 });
      }
      if (promptUsesPictureTags && !castBoardMode) {
        const invalidPicture = usedPictureNumbers.find((number) => number < 1 || number > characterIds.length);
        if (invalidPicture) {
          return Response.json({ error: `The prompt refers to <Picture ${invalidPicture}>, but only ${characterIds.length} character references are selected.` }, { status: 400 });
        }
        const originalIds = characterIds;
        const compactedNumbers = new Map(usedPictureNumbers.map((oldNumber, index) => [oldNumber, index + 1]));
        characterIds = usedPictureNumbers.map((number) => originalIds[number - 1]);
        prompt = prompt.replace(/<Picture\s+(\d+)>/giu, (tag, rawNumber: string) => {
          const compacted = compactedNumbers.get(Number(rawNumber));
          return compacted ? `<Picture ${compacted}>` : tag;
        });
        prompt = prompt.replace(/<Subject\s+(\d+)>/giu, (tag, rawNumber: string) => {
          const compacted = compactedNumbers.get(Number(rawNumber));
          return compacted ? `<Subject ${compacted}>` : tag;
        });
      }

      const characterNames: string[] = [];
      const characterDescriptions: string[] = [];
      const characterImagePaths: string[] = [];
      for (const id of characterIds) {
        const { profile, imagePath } = await getCharacter(id);
        characterNames.push(profile.name);
        characterDescriptions.push(profile.description);
        characterImagePaths.push(imagePath);
        if (!castBoardMode) {
          const bytes = await fs.readFile(imagePath);
          const reference = new File([bytes], profile.filename, { type: profile.mimeType });
          referenceImageNames.push(await uploadComfyImage(reference, profile.filename));
        }
      }
      if (castBoardMode) {
        const bytes = await createCastBoard(characterImagePaths);
        const reference = new File([bytes], `cast-board-${Date.now()}.png`, { type: "image/png" });
        referenceImageNames.push(await uploadComfyImage(reference, reference.name));
      }
      prompt = neutralizeReferenceCharacterNames(prompt, characterNames);
      if (!/<Subject\s+\d+>/iu.test(prompt)) {
        const subjectDefinitions = characterNames.map((_, index) =>
          castBoardMode
            ? `<Subject ${index + 1}> is the ${castBoardPosition(index, characterNames.length)} character in <Picture 1>. ${characterDescriptions[index]} <Picture 1> is the sole source of this subject's identity and visual style; do not infer culturally associated features.`
            : `<Subject ${index + 1}> is the character in <Picture ${index + 1}>. ${characterDescriptions[index]} <Picture ${index + 1}> is the sole source of this subject's identity and visual style; do not infer culturally associated features.`,
        ).join("\n");
        const retention = characterNames.map((_, index) =>
          `<Subject ${index + 1}> (appears in [Shot 1]): fully_preserved - preserve the exact face, skin tone, hair, costume, colors, body proportions, and illustration style from <Picture ${castBoardMode ? 1 : index + 1}>; do not reinterpret, blend, or add culturally associated clothing or headwear.`,
        ).join("\n");
        const scenePrompt = prompt.replace(/<Picture\s+(\d+)>/giu, "<Subject $1>");
        prompt = `subject_definitions:\n${subjectDefinitions}\n\nsummary:\n[reference generation] Generate the requested scene using only the defined subjects as the visual identity sources.\n\nretention_analysis:\n${retention}\n\ndetailed_description:\n[Shot 1] ${scenePrompt}`;
      }
    }

    const duration = Math.max(3, Math.min(12, Number(data.get("duration") ?? 5)));
    const narrationEnabled = data.get("narrationEnabled") === "true";
    const narrationText = String(data.get("narrationText") ?? "").trim();
    let narrationSegments = parseNarrationSegments(data.get("narrationSegments"), duration);
    let narrationVoice = String(data.get("narrationVoice") ?? "female");
    if (narrationEnabled && !narrationText && narrationSegments.length === 0) {
      return Response.json({ error: "Add the exact narration or dialogue for the TTS version." }, { status: 400 });
    }
    if (narrationEnabled) {
      const health = await fetch("http://127.0.0.1:8190/health").then((response) => response.json()) as { modelReady?: boolean };
      if (!health.modelReady) {
        return Response.json({ error: "IndicF5 is not unlocked yet. Accept the model access form first." }, { status: 503 });
      }
    }
    const distinctSpeakers = new Set(
      narrationText.split(/\r?\n/u).map((line) => line.match(/^([^:]{1,80}):\s*\S/u)?.[1]?.trim()).filter(Boolean),
    );
    if (narrationEnabled && narrationSegments.length === 0 && distinctSpeakers.size > 1) {
      const plannerResponse = await fetch(new URL("/api/enhance", request.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt,
          duration,
          aspect: String(data.get("aspect") ?? "16:9"),
          mode,
        }),
        signal: AbortSignal.timeout(90_000),
      });
      const planner = await plannerResponse.json() as { narrationSegments?: unknown; error?: string };
      if (plannerResponse.ok && Array.isArray(planner.narrationSegments)) {
        narrationSegments = parseNarrationSegments(JSON.stringify(planner.narrationSegments), duration);
      }
      if (narrationSegments.length === 0) {
        return Response.json({
          error: planner.error || "Gemini could not assign a separate voice and time window to every speaker. Refresh the studio and review the speaker plan before queueing.",
        }, { status: 400 });
      }
    }
    if (narrationEnabled && narrationVoice === "custom" && narrationSegments.length === 0) {
      const voiceAudio = data.get("voiceAudio");
      const voiceTranscript = String(data.get("voiceTranscript") ?? "").trim();
      if (!(voiceAudio instanceof File) || !voiceTranscript) {
        return Response.json({ error: "A custom voice needs a reference recording and its exact transcript." }, { status: 400 });
      }
      const voiceForm = new FormData();
      voiceForm.set("audio", voiceAudio, voiceAudio.name || `voice-${Date.now()}.wav`);
      voiceForm.set("transcript", voiceTranscript);
      const voiceResponse = await fetch("http://127.0.0.1:8190/voices", { method: "POST", body: voiceForm });
      if (!voiceResponse.ok) {
        const details = await voiceResponse.text().catch(() => "");
        throw new Error(`Could not save the custom voice${details ? `: ${details.slice(0, 180)}` : "."}`);
      }
      const voice = await voiceResponse.json() as { voiceId: string };
      narrationVoice = voice.voiceId;
    }

    const generationId = `H3_${Date.now()}`;
    const requestedMegapixels = Number(data.get("quality") ?? 0.4);
    const workflow = buildWorkflow({
      mode,
      prompt,
      originalPrompt,
      promptEnhanced,
      filenamePrefix: generationId,
      imageName,
      referenceImageNames,
      referenceFidelity: data.get("referenceFidelity") === "match" ? "match" : "max",
      aspect: String(data.get("aspect") ?? "16:9"),
      megapixels: mode === "r2v" && r2vCharacterCount > 1
        ? Math.max(0.6, requestedMegapixels)
        : requestedMegapixels,
      duration,
      steps: Number(data.get("steps") ?? 20),
      seed: Number(data.get("seed") ?? Date.now()),
      narration: narrationEnabled ? {
        enabled: true,
        text: narrationText,
        voice: narrationVoice,
        segments: narrationSegments,
        audioMode: "replace",
      } : undefined,
    });
    const queued = await (await comfyFetch("/prompt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: workflow, client_id: "h3-remote-studio" }),
    })).json() as { prompt_id: string; error?: string };

    if (!queued.prompt_id) throw new Error(queued.error || "ComfyUI did not accept the generation.");
    const metadataDirectory = path.join(OUTPUT_ROOT, "remote");
    await fs.mkdir(metadataDirectory, { recursive: true });
    await fs.writeFile(
      path.join(metadataDirectory, `${generationId}_studio.json`),
      JSON.stringify({
        schemaVersion: 1,
        promptId: queued.prompt_id,
        generationId,
        mode,
        originalPrompt,
        enhancedPrompt: prompt,
        promptEnhanced,
        createdAt: new Date().toISOString(),
      }, null, 2),
      "utf8",
    );
    return Response.json({ promptId: queued.prompt_id });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "Could not start generation.";
    return Response.json({ error: message }, { status: 500 });
  }
}
