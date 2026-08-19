const COMFY_URL = "http://127.0.0.1:8188";

export type GenerationMode = "t2v" | "i2v" | "r2v";

export type NarrationSegment = {
  speaker: string;
  voice: "male" | "female";
  language: string;
  startSeconds: number;
  endSeconds: number;
  text: string;
};

export type NarrationOptions = {
  enabled: boolean;
  text: string;
  voice: string;
  segments?: NarrationSegment[];
  audioMode: "replace";
};

export function parseStoredNarrationSegments(value: unknown): NarrationSegment[] {
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const entry = item as Record<string, unknown>;
      if (entry.voice !== "male" && entry.voice !== "female") return [];
      const speaker = String(entry.speaker ?? "").trim();
      const text = String(entry.text ?? "").trim();
      const startSeconds = Number(entry.startSeconds);
      const endSeconds = Number(entry.endSeconds);
      if (!speaker || !text || !Number.isFinite(startSeconds) || !Number.isFinite(endSeconds)) return [];
      return [{
        speaker,
        voice: entry.voice,
        language: String(entry.language ?? "").trim(),
        startSeconds,
        endSeconds,
        text,
      }];
    });
  } catch {
    return [];
  }
}

export async function comfyFetch(path: string, init?: RequestInit) {
  const response = await fetch(`${COMFY_URL}${path}`, init);
  if (!response.ok) {
    const details = await response.text().catch(() => "");
    throw new Error(`ComfyUI returned ${response.status}${details ? `: ${details.slice(0, 240)}` : ""}`);
  }
  return response;
}

export function calculateResolution(aspect: string, megapixels: number) {
  const ratios: Record<string, number> = { "16:9": 16 / 9, "9:16": 9 / 16, "1:1": 1, "4:3": 4 / 3 };
  const ratio = ratios[aspect] ?? 16 / 9;
  let width = Math.sqrt(megapixels * 1_000_000 * ratio);
  let height = width / ratio;
  const maxScale = Math.min(1, 1344 / Math.max(width, height));
  const shortScale = Math.min(1, 768 / Math.min(width, height));
  const scale = Math.min(maxScale, shortScale);
  width = Math.max(256, Math.ceil((width * scale) / 32) * 32);
  height = Math.max(256, Math.ceil((height * scale) / 32) * 32);
  return { width, height };
}

export function calculateLength(duration: number) {
  const frames = Math.max(5, Math.round(duration * 24));
  return frames + ((5 - (frames % 17)) % 17);
}

export function buildWorkflow(options: {
  mode: GenerationMode;
  prompt: string;
  originalPrompt?: string;
  promptEnhanced?: boolean;
  filenamePrefix?: string;
  aspect: string;
  megapixels: number;
  duration: number;
  steps: number;
  seed: number;
  imageName?: string;
  referenceImageNames?: string[];
  referenceFidelity?: "match" | "max";
  narration?: NarrationOptions;
}) {
  const { width, height } = calculateResolution(options.aspect, options.megapixels);
  const conditioningInputs: Record<string, unknown> = {
    prompt: options.prompt,
    width,
    height,
    length: calculateLength(options.duration),
    clip: ["4", 0],
    vae: ["1", 0],
  };
  if (options.mode === "i2v" && options.imageName) conditioningInputs.first_frame = ["15", 0];
  const referenceInputs: Record<string, unknown> = {
    prompt: options.prompt,
    width,
    height,
    length: calculateLength(options.duration),
    clip: ["4", 0],
    vae: ["1", 0],
    audio_vae: ["2", 0],
    ref_image_size: options.referenceFidelity ?? "max",
    ref_images: Object.fromEntries((options.referenceImageNames ?? []).map((_, index) => [
      `ref_image_${index + 1}`,
      [String(15 + index), 0],
    ])),
  };

  const workflow: Record<string, unknown> = {
    "1": { inputs: { vae_name: "minimax_h3_video_vae_fp16.safetensors" }, class_type: "VAELoader", _meta: { title: "Video VAE" } },
    "2": { inputs: { vae_name: "minimax_h3_audio_vae_fp32.safetensors" }, class_type: "VAELoader", _meta: { title: "Audio VAE" } },
    "3": { inputs: { unet_name: options.mode === "r2v" ? "minimax_h3_ref2va_pruned_int8_convrot.safetensors" : "minimax_h3_fl2va_pruned_int8_convrot.safetensors", weight_dtype: "default" }, class_type: "UNETLoader", _meta: { title: options.mode === "r2v" ? "MiniMax H3 R2V" : "MiniMax H3" } },
    "4": { inputs: { clip_name: "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors", type: "minimax", device: "default" }, class_type: "CLIPLoader", _meta: { title: "H3 Text Encoder" } },
    "5": { inputs: { noise_seed: Math.max(0, Math.floor(options.seed)) }, class_type: "RandomNoise", _meta: { title: "Seed" } },
    "6": options.mode === "r2v"
      ? { inputs: referenceInputs, class_type: "MiniMaxH3ReferenceToVideo", _meta: { title: "H3 Reference to Video" } }
      : { inputs: conditioningInputs, class_type: "MiniMaxH3ImageToVideo", _meta: { title: options.mode === "i2v" ? "H3 Image to Video" : "H3 Text to Video" } },
    "7": { inputs: { model: ["3", 0], conditioning: ["6", 0] }, class_type: "BasicGuider", _meta: { title: "Guider" } },
    "8": { inputs: { sampler_name: "res_multistep" }, class_type: "KSamplerSelect", _meta: { title: "Sampler" } },
    "9": { inputs: { scheduler: "simple", steps: Math.max(8, Math.min(40, Math.floor(options.steps))), denoise: 1, model: ["3", 0] }, class_type: "BasicScheduler", _meta: { title: "Schedule" } },
    "10": { inputs: { noise: ["5", 0], guider: ["7", 0], sampler: ["8", 0], sigmas: ["9", 0], latent_image: ["6", 1] }, class_type: "SamplerCustomAdvanced", _meta: { title: "Generate" } },
    "11": { inputs: { samples: ["10", 0], vae: ["1", 0] }, class_type: "VAEDecode", _meta: { title: "Decode Video" } },
    "12": { inputs: { samples: ["10", 0], vae: ["2", 0] }, class_type: "VAEDecodeAudio", _meta: { title: "Decode Audio" } },
    "13": { inputs: { fps: 24, bit_depth: 8, images: ["11", 0], audio: ["12", 0] }, class_type: "CreateVideo", _meta: { title: "Create Video" } },
    "14": {
      inputs: {
        filename_prefix: `remote/${options.filenamePrefix ?? `H3_${Date.now()}`}`,
        format: "auto",
        codec: "auto",
        video: ["13", 0],
      },
      class_type: "SaveVideo",
      _meta: {
        title: "Save Video",
        h3_tts: options.narration ? {
          enabled: options.narration.enabled,
          text: options.narration.text,
          voice: options.narration.voice,
          audioMode: options.narration.audioMode,
          // ComfyUI coerces nested metadata arrays; a JSON string survives queue/history round-trips.
          segmentsJson: JSON.stringify(options.narration.segments ?? []),
        } : undefined,
        h3_prompt: {
          originalPrompt: options.originalPrompt ?? options.prompt,
          enhancedPrompt: options.prompt,
          promptEnhanced: options.promptEnhanced === true,
        },
      },
    },
  };
  if (options.mode === "i2v" && options.imageName) {
    workflow["15"] = { inputs: { image: options.imageName }, class_type: "LoadImage", _meta: { title: "Starting Frame" } };
  }
  if (options.mode === "r2v") {
    (options.referenceImageNames ?? []).forEach((image, index) => {
      workflow[String(15 + index)] = { inputs: { image }, class_type: "LoadImage", _meta: { title: `Character reference ${index + 1}` } };
    });
  }
  return workflow;
}

export function findOutput(entry: Record<string, unknown>) {
  const outputs = (entry.outputs ?? {}) as Record<string, { images?: Array<{ filename: string; subfolder: string; type: string }> }>;
  for (const value of Object.values(outputs)) {
    const file = value.images?.find((item) => item.filename.toLowerCase().endsWith(".mp4"));
    if (file) return file;
  }
  return null;
}
