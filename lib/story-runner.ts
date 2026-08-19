/**
 * Bridge from the studio app to the Kathalu pipeline modules on H:.
 *
 * The pipeline is Python because that is where the OCR model, the torch TTS model and
 * ffmpeg live, and because those stacks pin against each other -- rapidocr wants numpy 2.x
 * while IndicF5's f5-tts pins numpy<=1.26.4, so each gets its own interpreter. This module
 * knows which interpreter runs what, and nothing else does.
 *
 * PATHS: this runtime ships the POSIX flavour of `node:path`, so `path.resolve` cannot
 * handle a `H:\...` drive path -- it treats the drive letter as a relative segment and
 * prepends the cwd, which made every containment check fail. So paths here are built and
 * compared as forward-slash strings with a normaliser of our own. Windows `fs` accepts
 * forward slashes throughout, and the Python side is handed absolute strings it parses
 * itself.
 */
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";

export const STUDIO_ROOT = "H:/KathaluStudio";
export const STORIES_ROOT = `${STUDIO_ROOT}/stories`;
export const LIBRARY_ROOT = `${STUDIO_ROOT}/characters`;

/** CPU tooling venv: OCR, OpenAI calls, ComfyUI orchestration, ffmpeg. */
const TOOLS_PY = `${STUDIO_ROOT}/ocr-venv/Scripts/python.exe`;

/**
 * The pipeline source lives in this repo under services/kathalu, so it is version
 * controlled with the app. H:/KathaluStudio holds only DATA -- the character library,
 * per-story folders, the venvs and model caches -- because C: has no room for it.
 */
// String.fromCharCode(92) is a backslash. Written this way because the shell used to
// author this file collapses escaped backslashes, which silently produced an invalid
// regex literal here more than once.
const REPO = process.cwd().split(String.fromCharCode(92)).join("/");
const KATHALU = `${REPO}/services/kathalu`;

export const MODULE_PATHS = {
  ocr: `${KATHALU}/ocr/page_reader.py`,
  cleanup: `${KATHALU}/llm/story_cleanup.py`,
  cast: `${KATHALU}/llm/character_extract.py`,
  script: `${KATHALU}/llm/write_script.py`,
  buildCast: `${KATHALU}/cast/build_cast.py`,
  pipeline: `${KATHALU}/render/pipeline.py`,
  applyEdits: `${KATHALU}/render/apply_edits.py`,
} as const;

/* ----------------------------------------------------------------- paths */

/** Collapse separators and resolve . and .. without touching the drive letter. */
export function normalisePath(input: string): string {
  const slashed = String(input).replace(/\\/g, "/");
  const parts: string[] = [];
  for (const segment of slashed.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  const joined = parts.join("/");
  return slashed.startsWith("/") ? `/${joined}` : joined;
}

function isUnder(root: string, candidate: string): boolean {
  const r = normalisePath(root).toLowerCase();
  const c = normalisePath(candidate).toLowerCase();
  return c === r || c.startsWith(`${r}/`);
}

export function join(...parts: string[]): string {
  return normalisePath(parts.join("/"));
}

export function basename(file: string): string {
  const n = normalisePath(file);
  return n.slice(n.lastIndexOf("/") + 1);
}

export function extname(file: string): string {
  const name = basename(file);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot) : "";
}

/** A story folder must sit inside the studio's stories root. */
export function safeStoryDir(dir: unknown): string {
  const value = normalisePath(String(dir ?? ""));
  if (!value || !isUnder(STORIES_ROOT, value) || value === normalisePath(STORIES_ROOT)) {
    throw new Error("That story folder is not inside the studio.");
  }
  return value;
}

/** An asset must sit inside the story folder it claims to belong to. */
export function safeAssetPath(dir: string, relative: unknown): string {
  const resolved = join(dir, String(relative ?? ""));
  if (!isUnder(dir, resolved) || resolved === normalisePath(dir)) {
    throw new Error("Invalid file.");
  }
  return resolved;
}

export function storySlug(title: string): string {
  // Keep Unicode letters. The first version stripped everything outside [a-z0-9], so a
  // Telugu title collapsed to nothing and the folder became story-<timestamp> -- unreadable,
  // and the whole point of these folders is that she can find her story in them. The source
  // pages are not always English: the first one she brought was a Telugu storybook.
  //
  // \p{M} is not optional. Telugu vowel signs and the virama are combining MARKS, not
  // letters, so a class of \p{L} alone turns చెడ్డ into చ-డ-డ -- consonant skeletons
  // with every vowel stripped, which is not a word in any language.
  const slug = title
    .toLowerCase()
    .normalize("NFC")
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || `story-${Date.now()}`;
}

/* ------------------------------------------------------------- processes */

export type RunResult = { code: number; stdout: string; stderr: string };

function pythonEnv() {
  return { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUNBUFFERED: "1" };
}

/** Await a Python module. These are the steps she waits on: 15-90 seconds each. */
export function runPython(script: string, args: string[], timeoutMs = 900_000): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(TOOLS_PY, ["-u", script, ...args], {
      cwd: script.slice(0, script.lastIndexOf("/")),
      env: pythonEnv(),
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${basename(script)} took longer than ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }); });
  });
}

/**
 * Start the render and return immediately. It runs for tens of minutes -- 39.5 min measured
 * for eight shots -- so it must outlive the request. `-u` is not optional: without it the
 * log sits in an 8 KB buffer and a crash leaves nothing to read.
 */
export async function startDetached(
  storyDir: string, script: string, args: string[], logName = "render",
) {
  const log = await fs.open(join(storyDir, `${logName}.log`), "a");
  const err = await fs.open(join(storyDir, `${logName}.err`), "a");
  const child = spawn(TOOLS_PY, ["-u", script, ...args], {
    cwd: script.slice(0, script.lastIndexOf("/")),
    env: pythonEnv(),
    detached: true,
    windowsHide: true,
    stdio: ["ignore", log.fd, err.fd],
  });
  child.unref();
  return child.pid;
}

export function startRender(storyDir: string, aspect: string, voice: string) {
  return startDetached(storyDir, MODULE_PATHS.pipeline,
    ["--story-dir", storyDir, "--aspect", aspect, "--voice", voice]);
}

/* ------------------------------------------------------------------ disk */

export async function readJson<T>(file: string): Promise<T | null> {
  try {
    // Read bytes and decode UTF-8 ourselves. Passing "utf8" to readFile came back
    // Latin-1-decoded in this runtime, which turned every Telugu title into mojibake
    // (0xE0 0xB0 0xA8 arriving as three separate characters instead of the letter it is).
    const bytes = await fs.readFile(file);
    return JSON.parse(new TextDecoder("utf-8").decode(bytes)) as T;
  } catch {
    return null;
  }
}

export async function exists(file: string) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

/* --------------------------------------------------------------- failures */

export const ERROR_LOG = `${REPO}/work/story-errors.log`;

/**
 * Record a failure and hand back a response she can act on.
 *
 * Two audiences at once. `error` is written for her -- plain language, says whether her work
 * survived. `ref` is a timestamp she can read out, and the same ref is written to
 * work/story-errors.log with the full technical detail, so the person fixing it can find the
 * exact incident instead of asking her to describe it.
 */
export async function fail(
  step: string, caught: unknown, opts: { status?: number; storyDir?: string; hint?: string } = {},
) {
  const ref = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const detail = caught instanceof Error ? (caught.stack || caught.message) : String(caught);
  const line = [
    `[${new Date().toISOString()}] ref=${ref} step=${step}`,
    opts.storyDir ? `story=${opts.storyDir}` : "",
    detail.replace(/\s+/g, " ").slice(0, 1800),
  ].filter(Boolean).join(" | ");
  try {
    await fs.mkdir(ERROR_LOG.slice(0, ERROR_LOG.lastIndexOf("/")), { recursive: true });
    await fs.appendFile(ERROR_LOG, line + String.fromCharCode(10), "utf8");
  } catch {
    /* logging must never be the thing that fails a request */
  }
  const message = caught instanceof Error ? caught.message : "Something went wrong.";
  return Response.json({
    error: message,
    step,
    ref,
    hint: opts.hint,
    detail: detail.slice(0, 900),
  }, { status: opts.status ?? 500 });
}

/* -------------------------------------------------------------- progress */

export type SceneProgress = {
  index: number; summary: string; telugu: string;
  seconds?: number; hasAudio: boolean; hasShot: boolean;
};

export type Progress = {
  stage: "idle" | "narrating" | "rendering" | "assembling" | "done";
  label: string; scenesDone: number; scenesTotal: number;
  minutesLeft: number | null; finalReady: boolean;
  /** When final.mp4 was last written. A rebuild begins with the previous film still on
   *  disk, so `finalReady` alone cannot tell a finished rebuild from a stale one. */
  finalUpdatedAt: number | null;
  scenes: SceneProgress[]; failed?: string;
};

/** Per-shot render cost measured in phase 4: ~1.15 s per output frame at 0.4 MP. */
const SECONDS_PER_FRAME = 1.15;

function pad(index: number) {
  return String(index).padStart(2, "0");
}

export async function readProgress(storyDir: string): Promise<Progress> {
  type Script = { scenes?: Array<{ index: number; summary_for_her: string; telugu_narration: string }> };
  type State = { stages?: Record<string, string>; scenes?: Record<string, { audio_seconds?: number }> };
  type Fit = { scenes?: Array<{ index: number; frames: number }> };

  const script = await readJson<Script>(join(storyDir, "script.json"));
  const state = await readJson<State>(join(storyDir, "state.json"));
  const fit = await readJson<Fit>(join(storyDir, "fit.json"));

  const scenes: SceneProgress[] = [];
  let shotsDone = 0;
  let audioDone = 0;
  for (const scene of script?.scenes ?? []) {
    const hasAudio = await exists(join(storyDir, "narration", `scene_${pad(scene.index)}.wav`));
    const hasShot = await exists(join(storyDir, "shots", `scene_${pad(scene.index)}.mp4`));
    if (hasAudio) audioDone += 1;
    if (hasShot) shotsDone += 1;
    scenes.push({
      index: scene.index,
      summary: scene.summary_for_her,
      telugu: scene.telugu_narration,
      seconds: state?.scenes?.[String(scene.index)]?.audio_seconds,
      hasAudio,
      hasShot,
    });
  }

  const total = scenes.length;
  const finalStat = await fs.stat(join(storyDir, "final.mp4")).catch(() => null);
  const finalReady = finalStat !== null;
  const finalUpdatedAt = finalStat ? finalStat.mtimeMs : null;
  const stages = state?.stages ?? {};
  // A redo writes its own log, so check both or a failed redo looks like silence.
  let errText = "";
  for (const name of ["redo.err", "render.err"]) {
    const bytes = await fs.readFile(join(storyDir, name)).catch(() => null);
    if (bytes) errText = new TextDecoder("utf-8").decode(bytes).trim() || errText;
  }
  const failed = errText.trim()
    ? errText.trim().split("\n").slice(-3).join(" ").slice(0, 300)
    : undefined;

  let stage: Progress["stage"] = "idle";
  let label = "Ready to start";
  let minutesLeft: number | null = null;

  if (finalReady) {
    stage = "done";
    label = "Your video is ready";
  } else if (shotsDone > 0 || stages.render) {
    stage = total > 0 && shotsDone === total ? "assembling" : "rendering";
    const doneIndexes = new Set(scenes.filter((s) => s.hasShot).map((s) => s.index));
    const remainingFrames = (fit?.scenes ?? [])
      .filter((f) => !doneIndexes.has(f.index))
      .reduce((sum, f) => sum + f.frames, 0);
    minutesLeft = remainingFrames > 0
      ? Math.max(1, Math.round((remainingFrames * SECONDS_PER_FRAME) / 60))
      : 1;
    label = stage === "assembling"
      ? "Putting the scenes together"
      : `Making scene ${Math.min(shotsDone + 1, total)} of ${total}`;
  } else if (audioDone > 0) {
    stage = "narrating";
    label = `Recording the telling (${audioDone} of ${total})`;
  }

  return {
    stage, label, scenesDone: shotsDone, scenesTotal: total,
    minutesLeft, finalReady, finalUpdatedAt, scenes, failed,
  };
}
