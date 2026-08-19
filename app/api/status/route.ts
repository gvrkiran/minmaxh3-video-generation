import { comfyFetch } from "@/lib/comfy";
import { promises as fs } from "node:fs";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [statsResponse, queueResponse, narration, r2vModelReady] = await Promise.all([
      comfyFetch("/system_stats"),
      comfyFetch("/queue"),
      fetch("http://127.0.0.1:8190/health")
        .then((response) => response.ok ? response.json() : null)
        .catch(() => null) as Promise<{ online?: boolean; modelReady?: boolean; activeJob?: string; lastError?: string } | null>,
      fs.access("H:\\ComfyUI_models\\models\\diffusion_models\\minimax_h3_ref2va_pruned_int8_convrot.safetensors")
        .then(() => true).catch(() => false),
    ]);
    const stats = await statsResponse.json() as { system: { comfyui_version: string }; devices: Array<{ name: string; vram_free: number }> };
    const queue = await queueResponse.json() as { queue_running: unknown[]; queue_pending: unknown[] };
    const device = stats.devices?.[0];
    return Response.json({
      online: true,
      queueRunning: queue.queue_running?.length ?? 0,
      queuePending: queue.queue_pending?.length ?? 0,
      gpu: device?.name,
      vramFreeGb: device ? device.vram_free / 1024 ** 3 : undefined,
      version: stats.system?.comfyui_version,
      narrationOnline: narration?.online === true && narration?.modelReady === true,
      narrationActive: Boolean(narration?.activeJob),
      narrationError: narration?.lastError,
      geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
      r2vModelReady,
    });
  } catch {
    return Response.json({ online: false, queueRunning: 0, queuePending: 0 });
  }
}
