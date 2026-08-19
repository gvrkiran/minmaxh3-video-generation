import { comfyFetch } from "@/lib/comfy";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const filename = url.searchParams.get("filename");
  if (!filename || filename.includes("..") || filename.includes("/") || filename.includes("\\")) {
    return new Response("Invalid filename", { status: 400 });
  }
  const params = new URLSearchParams({
    filename,
    subfolder: url.searchParams.get("subfolder") ?? "",
    type: url.searchParams.get("type") ?? "output",
  });
  try {
    const headers = new Headers();
    const range = request.headers.get("range");
    if (range) headers.set("range", range);
    const upstream = await comfyFetch(`/view?${params}`, { headers });
    const responseHeaders = new Headers();
    for (const name of ["content-type", "content-length", "content-range", "accept-ranges", "last-modified"]) {
      const value = upstream.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }
    responseHeaders.set("cache-control", "private, max-age=3600");
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  } catch {
    return new Response("Video unavailable", { status: 404 });
  }
}
