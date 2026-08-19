/** Serve portraits, narration wavs and finished videos off H:.
 *
 * Two shapes only: `library=<filename>` for a character portrait, or `dir=&rel=` for
 * something inside one story folder. Both are resolved and then checked to still be inside
 * the studio root, so a crafted `rel` cannot walk out to the rest of the disk.
 */
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { LIBRARY_ROOT, safeAssetPath, safeStoryDir } from "@/lib/story-runner";

export const dynamic = "force-dynamic";

const TYPES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".wav": "audio/wav", ".mp4": "video/mp4", ".json": "application/json",
};

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const library = params.get("library");

    let file: string;
    if (library) {
      if (library.includes("..") || library.includes("/") || library.includes("\\")) {
        return new Response("Invalid file", { status: 400 });
      }
      file = path.join(LIBRARY_ROOT, library);
    } else {
      file = safeAssetPath(safeStoryDir(params.get("dir")), params.get("rel"));
    }

    const stat = await fs.stat(file);
    const type = TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
    const range = request.headers.get("range");

    // Video needs range support or scrubbing a 90-second file re-downloads it every seek.
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
