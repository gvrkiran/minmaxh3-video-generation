import { readProgress, safeStoryDir } from "@/lib/story-runner";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const dir = safeStoryDir(new URL(request.url).searchParams.get("dir"));
    return Response.json(await readProgress(dir));
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "Could not check progress.";
    return Response.json({ error: message }, { status: 500 });
  }
}
