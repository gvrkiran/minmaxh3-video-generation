/** Serve a finished reel out of its own folder. `slug=&rel=`, nothing else.
 *
 * Range support is not optional: without it, every scrub of the video re-downloads the whole
 * file, and she is likely watching this over Tailscale on a phone.
 *
 * Same as the garden's and the painting's file routes -- `safeReelAsset` does not care what
 * kind of reel a folder holds, only that the path stays inside it. The no-voice cut is served
 * from here too; it lives beside the two narrated cuts under the same rules.
 */
import { createReadStream, promises as fs } from "node:fs";
import { Readable } from "node:stream";
import { safeReelAsset } from "@/lib/reels-runner";
import { extname } from "@/lib/story-runner";

export const dynamic = "force-dynamic";

const TYPES: Record<string, string> = {
  ".mp4": "video/mp4", ".wav": "audio/wav", ".json": "application/json",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
};

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    // safeReelAsset validates the slug and confirms the resolved path is still inside that
    // one reel's folder, so a crafted `rel` cannot walk out to the rest of the disk.
    const file = await safeReelAsset(String(params.get("slug") ?? ""), params.get("rel"));

    const stat = await fs.stat(file);
    const type = TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
    const range = request.headers.get("range");

    if (range) {
      const match = /bytes=(\d*)-(\d*)/.exec(range);
      const start = match?.[1] ? Number(match[1]) : 0;
      const end = match?.[2] ? Number(match[2]) : stat.size - 1;
      if (start >= stat.size || end >= stat.size || start > end) {
        return new Response("Range not satisfiable", {
          status: 416, headers: { "content-range": `bytes */${stat.size}` },
        });
      }
      const stream = Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream;
      return new Response(stream, {
        status: 206,
        headers: {
          "content-type": type,
          "content-length": String(end - start + 1),
          "content-range": `bytes ${start}-${end}/${stat.size}`,
          "accept-ranges": "bytes",
          "cache-control": "private, max-age=600",
        },
      });
    }

    const stream = Readable.toWeb(createReadStream(file)) as ReadableStream;
    return new Response(stream, {
      headers: {
        "content-type": type,
        "content-length": String(stat.size),
        "accept-ranges": "bytes",
        "cache-control": "private, max-age=600",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
