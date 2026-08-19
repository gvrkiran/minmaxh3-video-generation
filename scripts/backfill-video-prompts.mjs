import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const outputRoot = process.env.COMFY_OUTPUT_ROOT ?? "C:\\Users\\kg766\\Downloads\\ComfyUI\\output";
const remoteRoot = path.join(outputRoot, "remote");

const entries = await fs.readdir(remoteRoot, { withFileTypes: true });
let recovered = 0;
let alreadyStored = 0;

for (const entry of entries) {
  if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".mp4") || /_tts\.mp4$/i.test(entry.name)) continue;
  const generationId = entry.name.match(/^(H3_\d+)/i)?.[1];
  if (!generationId) continue;
  const metadataPath = path.join(remoteRoot, `${generationId}_studio.json`);
  try {
    await fs.access(metadataPath);
    alreadyStored += 1;
    continue;
  } catch {
    // Recover legacy metadata from the workflow embedded in the MP4.
  }

  try {
    const { stdout } = await run("ffprobe.exe", [
      "-v", "error",
      "-show_entries", "format_tags=prompt",
      "-of", "json",
      path.join(remoteRoot, entry.name),
    ], { maxBuffer: 8 * 1024 * 1024 });
    const envelope = JSON.parse(stdout);
    const workflow = JSON.parse(envelope?.format?.tags?.prompt ?? "{}");
    const generator = Object.values(workflow).find((node) => node?.class_type === "MiniMaxH3ImageToVideo" || node?.class_type === "MiniMaxH3ReferenceToVideo");
    if (!generator?.inputs?.prompt) continue;
    const mode = generator.class_type === "MiniMaxH3ReferenceToVideo" ? "r2v" : generator.inputs.first_frame ? "i2v" : "t2v";
    await fs.writeFile(metadataPath, JSON.stringify({
      schemaVersion: 1,
      generationId,
      mode,
      enhancedPrompt: String(generator.inputs.prompt),
      promptEnhanced: false,
      recoveredFrom: "embedded ComfyUI workflow",
      createdAt: new Date().toISOString(),
    }, null, 2), "utf8");
    recovered += 1;
  } catch (error) {
    process.stderr.write(`Could not recover ${entry.name}: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

process.stdout.write(JSON.stringify({ recovered, alreadyStored }, null, 2));
