import { comfyFetch, findOutput } from "@/lib/comfy";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return Response.json({ status: "error", error: "Missing job id." }, { status: 400 });
  try {
    const history = await (await comfyFetch(`/history/${encodeURIComponent(id)}`)).json() as Record<string, Record<string, unknown>>;
    const entry = history[id];
    if (entry) {
      const output = findOutput(entry);
      const jobStatus = entry.status as { status_str?: string; completed?: boolean; messages?: unknown[] } | undefined;
      if (output) {
        const query = new URLSearchParams({ filename: output.filename, subfolder: output.subfolder || "", type: output.type || "output" });
        return Response.json({ status: "completed", videoUrl: `/api/view?${query}` });
      }
      if (jobStatus?.status_str === "error") {
        return Response.json({ status: "error", error: "ComfyUI reported an error while generating the video." });
      }
    }

    const queue = await (await comfyFetch("/queue")).json() as { queue_running: unknown[][]; queue_pending: unknown[][] };
    const isRunning = queue.queue_running?.some((item) => item?.[1] === id);
    const isQueued = queue.queue_pending?.some((item) => item?.[1] === id);
    return Response.json({ status: isRunning ? "running" : isQueued ? "queued" : "running" });
  } catch (caught) {
    return Response.json({ status: "error", error: caught instanceof Error ? caught.message : "Could not read the job." }, { status: 500 });
  }
}
