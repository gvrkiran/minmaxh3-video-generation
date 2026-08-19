import { promises as fs } from "node:fs";
import path from "node:path";

import { comfyFetch, findOutput, GenerationMode, NarrationSegment, parseStoredNarrationSegments } from "@/lib/comfy";

export const dynamic = "force-dynamic";

const OUTPUT_ROOT = process.env.COMFY_OUTPUT_ROOT ?? "C:\\Users\\kg766\\Downloads\\ComfyUI\\output";
const ARCHIVE_ROOT = path.join(OUTPUT_ROOT, "remote");

type HistoryMetadata = {
  id: string;
  mode: GenerationMode;
  prompt: string;
  originalPrompt?: string;
  enhancedPrompt?: string;
  promptEnhanced?: boolean;
  narrationRequested: boolean;
  speakerPlan: NarrationSegment[];
};

type DiskVideo = {
  filename: string;
  subfolder: string;
  fullPath: string;
  createdAt: number;
};

type StudioMetadata = {
  promptId?: string;
  mode?: GenerationMode;
  originalPrompt?: string;
  enhancedPrompt?: string;
  promptEnhanced?: boolean;
};

function archiveKey(subfolder: string, filename: string) {
  return `${subfolder.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "")}/${filename}`;
}

async function listOriginalVideos(directory = ARCHIVE_ROOT, subfolder = "remote"): Promise<DiskVideo[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const videos = await Promise.all(entries.map(async (entry): Promise<DiskVideo[]> => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return listOriginalVideos(fullPath, `${subfolder}/${entry.name}`);
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".mp4") || /_tts\.mp4$/i.test(entry.name)) return [];
    const stat = await fs.stat(fullPath);
    return [{ filename: entry.name, subfolder, fullPath, createdAt: stat.mtimeMs }];
  }));
  return videos.flat();
}

async function readSidecarSpeakerPlan(video: DiskVideo) {
  const stem = path.parse(video.filename).name;
  const sidecar = path.join(path.dirname(video.fullPath), `${stem}_tts.json`);
  try {
    const parsed = JSON.parse(await fs.readFile(sidecar, "utf8")) as { segments?: unknown };
    return parseStoredNarrationSegments(JSON.stringify(parsed.segments ?? []));
  } catch {
    return [];
  }
}

async function readStudioMetadata(video: DiskVideo): Promise<StudioMetadata | null> {
  const generationId = video.filename.match(/^(H3_\d+)/i)?.[1];
  if (!generationId) return null;
  try {
    return JSON.parse(await fs.readFile(path.join(path.dirname(video.fullPath), `${generationId}_studio.json`), "utf8")) as StudioMetadata;
  } catch {
    return null;
  }
}

async function buildMetadataMaps() {
  const byPath = new Map<string, HistoryMetadata>();
  const byFilename = new Map<string, HistoryMetadata>();

  try {
    const response = await comfyFetch("/history");
    const history = await response.json() as Record<string, Record<string, unknown>>;
    for (const [id, entry] of Object.entries(history)) {
      const promptEnvelope = entry.prompt as unknown[] | undefined;
      const graph = promptEnvelope?.[2] as Record<string, { class_type?: string; inputs?: Record<string, unknown>; _meta?: {
        h3_tts?: { enabled?: boolean; segmentsJson?: unknown };
        h3_prompt?: { originalPrompt?: unknown; enhancedPrompt?: unknown; promptEnhanced?: unknown };
      } }> | undefined;
      if (!graph) continue;

      const generator = Object.values(graph).find((node) => node.class_type === "MiniMaxH3ImageToVideo" || node.class_type === "MiniMaxH3ReferenceToVideo");
      const output = findOutput(entry);
      if (!generator || !output) continue;

      const narrationNode = Object.values(graph).find((node) => node._meta?.h3_tts?.enabled === true);
      const promptNode = Object.values(graph).find((node) => node._meta?.h3_prompt);
      const promptRecord = promptNode?._meta?.h3_prompt;
      const mode: GenerationMode = generator.class_type === "MiniMaxH3ReferenceToVideo" ? "r2v" : generator.inputs?.first_frame ? "i2v" : "t2v";
      const metadata: HistoryMetadata = {
        id,
        mode,
        prompt: String(generator.inputs?.prompt ?? "MiniMax H3 generation"),
        originalPrompt: typeof promptRecord?.originalPrompt === "string" ? promptRecord.originalPrompt : undefined,
        enhancedPrompt: typeof promptRecord?.enhancedPrompt === "string" ? promptRecord.enhancedPrompt : undefined,
        promptEnhanced: promptRecord?.promptEnhanced === true,
        narrationRequested: narrationNode?._meta?.h3_tts?.enabled === true,
        speakerPlan: parseStoredNarrationSegments(narrationNode?._meta?.h3_tts?.segmentsJson),
      };
      byPath.set(archiveKey(output.subfolder || "", output.filename), metadata);
      if (!byFilename.has(output.filename)) byFilename.set(output.filename, metadata);
    }
  } catch {
    // The MP4 archive remains available even while ComfyUI is restarting.
  }

  return { byPath, byFilename };
}

export async function GET() {
  try {
    const [videos, metadataMaps] = await Promise.all([listOriginalVideos(), buildMetadataMaps()]);
    const items = await Promise.all(videos.map(async (video) => {
      const stem = path.parse(video.filename).name;
      const narratedFilename = `${stem}_tts.mp4`;
      const narratedPath = path.join(path.dirname(video.fullPath), narratedFilename);
      const hasNarratedVersion = await fs.access(narratedPath).then(() => true).catch(() => false);
      const metadata = metadataMaps.byPath.get(archiveKey(video.subfolder, video.filename)) ?? metadataMaps.byFilename.get(video.filename);
      const [sidecarSpeakerPlan, studioMetadata] = await Promise.all([
        readSidecarSpeakerPlan(video),
        readStudioMetadata(video),
      ]);
      const enhancedPrompt = studioMetadata?.enhancedPrompt ?? metadata?.enhancedPrompt ?? metadata?.prompt;
      const originalPrompt = studioMetadata?.originalPrompt ?? metadata?.originalPrompt;

      return {
        id: studioMetadata?.promptId ?? metadata?.id ?? `disk:${archiveKey(video.subfolder, video.filename)}`,
        mode: studioMetadata?.mode ?? metadata?.mode ?? "t2v",
        prompt: enhancedPrompt ?? "MiniMax H3 generation recovered from the render archive",
        originalPrompt,
        enhancedPrompt,
        promptEnhanced: studioMetadata?.promptEnhanced ?? metadata?.promptEnhanced ?? false,
        filename: video.filename,
        narratedFilename: hasNarratedVersion ? narratedFilename : undefined,
        narrationRequested: metadata?.narrationRequested === true || hasNarratedVersion,
        speakerPlan: metadata?.speakerPlan.length ? metadata.speakerPlan : sidecarSpeakerPlan,
        subfolder: video.subfolder,
        createdAt: video.createdAt,
      };
    }));

    items.sort((a, b) => b.createdAt - a.createdAt);
    return Response.json({ items, total: items.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to read the video archive";
    return Response.json({ items: [], total: 0, error: message }, { status: 500 });
  }
}
