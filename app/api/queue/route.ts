import { comfyFetch, parseStoredNarrationSegments } from "@/lib/comfy";

export const dynamic = "force-dynamic";

type GraphNode = {
  class_type?: string;
  inputs?: Record<string, unknown>;
};

type QueueItem = [
  number,
  string,
  Record<string, GraphNode>,
  { create_time?: number },
  string[],
];

type ComfyQueue = {
  queue_running?: QueueItem[];
  queue_pending?: QueueItem[];
};

function summarize(item: QueueItem, state: "running" | "pending", index: number) {
  const graph = item[2] ?? {};
  const generator = Object.values(graph).find((node) => node.class_type === "MiniMaxH3ImageToVideo" || node.class_type === "MiniMaxH3ReferenceToVideo");
  const inputs = generator?.inputs ?? {};
  const scheduler = Object.values(graph).find((node) => node.class_type === "BasicScheduler");
  const noise = Object.values(graph).find((node) => node.class_type === "RandomNoise");
  const narrationNode = Object.values(graph).find((node) => {
    const meta = node as GraphNode & { _meta?: { h3_tts?: { enabled?: boolean } } };
    return meta._meta?.h3_tts?.enabled === true;
  }) as GraphNode & { _meta?: { h3_tts?: { enabled?: boolean; segmentsJson?: unknown } } } | undefined;
  const narration = narrationNode?._meta?.h3_tts?.enabled === true;
  const speakerPlan = parseStoredNarrationSegments(narrationNode?._meta?.h3_tts?.segmentsJson);
  const length = Number(inputs.length ?? 0);

  return {
    id: item[1],
    state,
    position: state === "running" ? 0 : index + 1,
    mode: generator?.class_type === "MiniMaxH3ReferenceToVideo" ? "r2v" : inputs.first_frame ? "i2v" : "t2v",
    prompt: String(inputs.prompt ?? "MiniMax H3 generation"),
    width: Number(inputs.width ?? 0),
    height: Number(inputs.height ?? 0),
    duration: length ? Math.round((length / 24) * 10) / 10 : 0,
    steps: Number(scheduler?.inputs?.steps ?? 0),
    seed: Number(noise?.inputs?.noise_seed ?? 0),
    narration,
    speakerPlan,
    createdAt: item[3]?.create_time,
  };
}

export async function GET() {
  try {
    const queue = await (await comfyFetch("/queue")).json() as ComfyQueue;
    const running = (queue.queue_running ?? []).map((item, index) => summarize(item, "running", index));
    const pending = (queue.queue_pending ?? []).map((item, index) => summarize(item, "pending", index));
    return Response.json({ jobs: [...running, ...pending] });
  } catch (caught) {
    return Response.json(
      { jobs: [], error: caught instanceof Error ? caught.message : "Could not load the queue." },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as { action?: string; id?: string };
    if (body.action === "clear") {
      await comfyFetch("/queue", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clear: true }),
      });
      return Response.json({ ok: true });
    }

    if (body.action !== "cancel" || !body.id) {
      return Response.json({ error: "Invalid queue action." }, { status: 400 });
    }

    const queue = await (await comfyFetch("/queue")).json() as ComfyQueue;
    const isRunning = (queue.queue_running ?? []).some((item) => item[1] === body.id);
    if (isRunning) {
      await comfyFetch("/interrupt", { method: "POST" });
    } else {
      await comfyFetch("/queue", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ delete: [body.id] }),
      });
    }
    return Response.json({ ok: true });
  } catch (caught) {
    return Response.json(
      { error: caught instanceof Error ? caught.message : "Could not update the queue." },
      { status: 500 },
    );
  }
}
