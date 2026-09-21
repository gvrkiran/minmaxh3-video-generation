/**
 * Bridge from the studio app to ReelsLab -- the gardening-reel pipeline on H:.
 *
 * Deliberately a sibling of story-runner.ts rather than an extension of it. The two share a
 * graphics card and a set of hard-won Windows workarounds, and nothing else: no characters,
 * no OCR, no cast library, a different H3 mode and a different output shape. Folding them
 * together would mean every change to one risking the other.
 *
 * The same three runtime traps apply here, and each cost real time to find once already:
 *
 *   PATHS   -- this runtime ships the POSIX flavour of `node:path`, so `path.resolve` treats
 *              the `H:` in `H:\ReelsLab` as a relative segment and prepends the cwd. Paths
 *              are therefore built and compared as forward-slash strings, reusing
 *              story-runner's normaliser rather than writing a second one.
 *   UTF-8   -- `fs.readFile(file, "utf8")` comes back Latin-1-decoded here, which turns every
 *              Telugu title into mojibake. Read bytes, decode with TextDecoder.
 *   `-u`    -- without it a detached render's log sits in an 8 KB buffer, and a crash on this
 *              machine (see the 0x3B bugchecks) leaves nothing to read.
 */
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";

import { join, normalisePath, readJson, exists } from "@/lib/story-runner";

export const REELS_ROOT = "H:/ReelsLab";
/** Reels typed by a person, one folder each, kept apart from the curated fourteen. */
export const USER_ROOT = `${REELS_ROOT}/user`;
/** The curated reels, written by hand into videos.json and rendered by the batch. */
export const CURATED_ROOT = `${REELS_ROOT}/out`;
const CURATED_SPEC = `${REELS_ROOT}/videos.json`;

/** Same CPU tooling venv the story side uses; verified to run both ReelsLab modules. */
const TOOLS_PY = "H:/KathaluStudio/ocr-venv/Scripts/python.exe";

export const REELS_MODULES = {
  write: `${REELS_ROOT}/llm/write_reel.py`,
  // New ideas, one or several, screened against everything this lab has already made or
  // been asked for. `--genre garden|paint`, `--count`, `--lang te|en`, an avoid-list on
  // stdin, and it prints `IDEAS [...]`. One module for both genres deliberately: the reading
  // of history, the repeat check and the retry loop are identical, and only the brief
  // differs -- which is exactly the split `llm/genres.py` already makes for writing a reel.
  ideas: `${REELS_ROOT}/llm/suggest_ideas.py`,
  pipeline: `${REELS_ROOT}/reels.py`,
} as const;

/**
 * The kinds of reel the lab writes. Same pipeline, same faceless rule, same two voices; what
 * differs is the brief the model writes from (`llm/genres.py`) and which page owns the result.
 *
 * A reel's kind is recorded in its own spec.json, and reels made before there was a second
 * kind carry none -- they were all gardening, and `kindOfSpec` reads them that way. The slug
 * prefix is only a courtesy for anyone browsing `user/` by hand; nothing decides on it.
 * `draft-` is kept for the garden because a hundred reels already carry it.
 *
 * `concept` is the general case -- whatever was typed, improved into an angle by the model
 * and told in four to six shots -- and the one whose page hands the voice-over script back,
 * because a synthesised Telugu voice is the part its owner is likeliest to want to replace.
 */
export type ReelKind = "garden" | "paint" | "concept";
export const KINDS: readonly ReelKind[] = ["garden", "paint", "concept"];
const SLUG_PREFIX: Record<ReelKind, string> = { garden: "draft", paint: "paint", concept: "concept" };

export function reelKind(input: unknown): ReelKind {
  const value = String(input ?? "garden");
  if (!(KINDS as readonly string[]).includes(value)) {
    throw new Error("That kind of video is not one this studio makes.");
  }
  return value as ReelKind;
}

/** A fresh slug for a reel of this kind. `stamp` is base-36 time, with a suffix for a list. */
export function newSlug(kind: ReelKind, stamp = Date.now().toString(36)): string {
  return `${SLUG_PREFIX[kind]}-${stamp}`;
}

/** The kind a spec declares, or the garden for the specs written before kinds existed. */
export function kindOfSpec(video: { kind?: string } | undefined): ReelKind {
  const kind = video?.kind;
  return kind && (KINDS as readonly string[]).includes(kind) ? (kind as ReelKind) : "garden";
}

export type ReelPlan = {
  slug: string;
  kind: ReelKind;
  titleTe: string;
  titleEn: string;
  understood: string;
  narrationTe: string[];
  /** Present on plans written since the English toggle needed it; older callers ignore it. */
  narrationEn?: string[];
  /** The look the plan chose, for genres that choose one (`h3_t2v.STYLES` keys); else null. */
  style?: string | null;
  styleLabel?: string | null;
  spec: string;
};

/* ----------------------------------------------------------------- paths */

function isUnder(root: string, candidate: string): boolean {
  const r = normalisePath(root).toLowerCase();
  const c = normalisePath(candidate).toLowerCase();
  return c === r || c.startsWith(`${r}/`);
}

/**
 * A slug becomes a directory name, so it is validated rather than trusted. Restricted to
 * lowercase ASCII, digits and single hyphens: the slug comes from the model's English title,
 * never from the typed Telugu, so there is nothing to lose by being strict.
 */
export function safeSlug(input: unknown): string {
  const value = String(input ?? "").trim();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) || value.length > 64) {
    throw new Error("That video name is not one this studio made.");
  }
  return value;
}

/**
 * Where a reel she made lives. Always the user root -- rendering only ever writes there.
 */
export function reelDir(slug: string): string {
  const dir = join(USER_ROOT, safeSlug(slug));
  if (!isUnder(USER_ROOT, dir) || dir === normalisePath(USER_ROOT)) {
    throw new Error("That video folder is not inside the studio.");
  }
  return dir;
}

/**
 * Where a reel lives for *reading*, which is either root.
 *
 * Separate from `reelDir` on purpose: writing must be confined to `user/`, so that a bug or
 * a crafted slug can never have the app render over the curated set. Reading is allowed from
 * both, because the library shows them together. `user/` is checked first so a reel she made
 * would shadow a curated one of the same name rather than the other way round.
 */
export async function findReelDir(slug: string): Promise<string> {
  const safe = safeSlug(slug);
  for (const root of [USER_ROOT, CURATED_ROOT]) {
    const dir = join(root, safe);
    if (await exists(join(dir, `${safe}_te.mp4`))) return dir;
  }
  throw new Error("That video is not one this studio made.");
}

/** An asset must sit inside the reel folder it claims to belong to. */
export async function safeReelAsset(slug: string, relative: unknown): Promise<string> {
  const dir = await findReelDir(slug);
  const resolved = join(dir, String(relative ?? ""));
  if (!isUnder(dir, resolved) || resolved === normalisePath(dir)) {
    throw new Error("Invalid file.");
  }
  return resolved;
}

/* ------------------------------------------------------------- processes */

function pythonEnv() {
  return { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUNBUFFERED: "1" };
}

type RunResult = { code: number; stdout: string; stderr: string };

/** Run a ReelsLab module to completion. `input`, if given, is written to its stdin then closed. */
function run(script: string, args: string[], timeoutMs: number, input = ""): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(TOOLS_PY, ["-u", script, ...args], {
      cwd: REELS_ROOT,
      env: pythonEnv(),
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`The model took longer than ${Math.round(timeoutMs / 1000)}s.`));
    }, timeoutMs);
    child.stdout.on("data", (c) => { stdout += String(c); });
    child.stderr.on("data", (c) => { stderr += String(c); });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }); });
    // Always closed, even when empty: a module that reads stdin must see end-of-file, and one
    // that never reads it is unaffected.
    child.stdin.end(input);
  });
}

/**
 * Ask the model for a plan. Blocking, and she is watching the screen while it runs -- the
 * module is pinned to low reasoning effort for exactly that reason. Typically 15-40s.
 */
export async function writePlan(tip: string, kind: ReelKind = "garden"): Promise<ReelPlan> {
  const slug = newSlug(kind);
  const out = join(USER_ROOT, slug, "spec.json");
  const got = await run(REELS_MODULES.write,
    ["--tip", tip, "--out", out, "--slug", slug, "--genre", kind], 420_000);
  if (got.code !== 0) {
    // The module's own SystemExit messages are the useful ones -- they name the checks that
    // failed. Prefer them over a generic failure.
    const detail = (got.stderr || got.stdout).trim().slice(-1200);
    throw new Error(detail || "The plan could not be written.");
  }
  const line = got.stdout.split("\n").find((l) => l.startsWith("SPEC "));
  if (!line) throw new Error("The plan came back in a shape this studio did not expect.");
  return JSON.parse(line.slice(5)) as ReelPlan;
}

/**
 * Ask the model for `count` new ideas of this kind, none of them already made here.
 *
 * `suggest_ideas.py` reads every reel and list on disk for the history itself; `avoid` is
 * what only the page knows -- the lines already in the box, the ideas it has shown before in
 * this sitting -- and goes over stdin so a pasted list of twenty cannot overflow argv.
 * Blocking, 5-20 s at low effort; the page says it is thinking meanwhile.
 *
 * `lang` is the language of the IDEAS, not of the page asking for them. /garden opens in
 * Telugu and drops the answer straight into a box its reader then edits, so there it has to
 * come back in Telugu script; the list pages ask in English.
 */
export async function suggestIdeas(
  kind: ReelKind, count: number, avoid: string[] = [], lang: "te" | "en" = "en",
): Promise<string[]> {
  const n = Math.max(1, Math.min(25, Math.floor(count)));
  // 300s, not 150: the gardening history is past 200 ideas and the module gets four novelty
  // retries against it, so the old ceiling could cut off a call that was working.
  const got = await run(REELS_MODULES.ideas,
    ["--genre", kind, "--count", String(n), "--lang", lang], 300_000,
    JSON.stringify({ avoid }));
  if (got.code !== 0) {
    const detail = (got.stderr || got.stdout).trim().slice(-600);
    throw new Error(detail || "No ideas came back.");
  }
  const line = got.stdout.split("\n").find((l) => l.startsWith("IDEAS "));
  if (!line) throw new Error("The ideas came back in a shape this studio did not expect.");
  const ideas = JSON.parse(line.slice(6)) as unknown;
  if (!Array.isArray(ideas)) throw new Error("The ideas came back in a shape this studio did not expect.");
  return ideas.map(String).filter((s) => s.trim());
}

/**
 * Start the render and return immediately. Twenty minutes or so for three shots, and this
 * machine reboots under sustained load, so it must both outlive the request and be safe to
 * re-run. `reels.py` skips every shot already on disk.
 */
export async function startReelRender(slug: string): Promise<number | undefined> {
  const dir = reelDir(slug);
  const log = await fs.open(join(dir, "render.log"), "a");
  // The log is appended -- a resume should keep what the lost run said. The error file is
  // TRUNCATED, the opposite call and a deliberate one, the same one batch_reels.py makes: a
  // non-empty render.err reads as "this reel failed" everywhere, so an inherited traceback
  // would make a retry that is working perfectly well report itself broken for its whole
  // run, and "tap to carry on" would land straight back on the failure screen.
  const err = await fs.open(join(dir, "render.err"), "w");
  const child = spawn(TOOLS_PY, ["-u", REELS_MODULES.pipeline,
    "--spec", join(dir, "spec.json"),
    "--slug", slug,
    "--out-root", USER_ROOT,
    // Queue behind another render rather than refusing. From her side of the screen waiting
    // is a queue and an error is a wall, and the curated batch is running most of the time.
    "--wait-for-lock",
  ], {
    cwd: REELS_ROOT,
    env: pythonEnv(),
    detached: true,
    windowsHide: true,
    stdio: ["ignore", log.fd, err.fd],
  });
  child.unref();
  return child.pid;
}

/* -------------------------------------------------------------- library */

export type LibraryItem = {
  slug: string;
  kind: ReelKind;
  titleTe: string;
  titleEn: string;
  seconds: number | null;
  languages: Array<"te" | "en">;
  source: "made" | "library";
  madeAt: number | null;
  poster: boolean;
};

/** Duration straight from the mp4 container, via ffprobe. */
async function probeSeconds(file: string): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn("ffprobe", [
      "-v", "error", "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1", file,
    ], { windowsHide: true });
    let out = "";
    child.stdout.on("data", (c) => { out += String(c); });
    child.on("error", () => resolve(null));
    child.on("close", () => {
      const n = Number(out.trim());
      resolve(Number.isFinite(n) ? Math.round(n * 10) / 10 : null);
    });
  });
}

/**
 * One still per reel, for the card. Generated once and cached beside the video.
 *
 * Taken at 1.2s rather than at 0, because the first frames of an H3 shot are the least
 * settled -- a poster from frame 0 is regularly the blurriest image in the whole clip.
 */
async function ensurePoster(dir: string, slug: string): Promise<boolean> {
  const poster = join(dir, "poster.jpg");
  if (await exists(poster)) return true;
  const video = join(dir, `${slug}_te.mp4`);
  if (!await exists(video)) return false;
  return new Promise((resolve) => {
    const child = spawn("ffmpeg", [
      "-v", "error", "-y", "-ss", "1.2", "-i", video,
      "-frames:v", "1", "-vf", "scale=360:-2", "-q:v", "5", poster,
    ], { windowsHide: true });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

type SpecVideo = { slug: string; kind?: string; title?: string; title_te?: string };

async function readCuratedTitles(): Promise<Map<string, SpecVideo>> {
  const spec = await readJson<{ videos: SpecVideo[] }>(CURATED_SPEC);
  return new Map((spec?.videos ?? []).map((v) => [v.slug, v]));
}

/**
 * Everything finished, newest first, from both roots.
 *
 * Driven off the filesystem rather than an index file. An index is one more thing to keep in
 * step, and on a machine that has taken three unclean shutdowns in two days, the mp4 that
 * exists is the only claim worth trusting.
 *
 * With a `kind`, only reels of that kind: each page shows its own shelf. Without one,
 * everything -- which is what the pages did before there was a second kind.
 */
export async function listLibrary(kind?: ReelKind): Promise<LibraryItem[]> {
  const curated = await readCuratedTitles();
  const items: LibraryItem[] = [];

  for (const [root, source] of [[USER_ROOT, "made"], [CURATED_ROOT, "library"]] as const) {
    // The curated fourteen were all written as gardening reels, before there was a second
    // kind; a painting shelf has nothing to take from that root.
    if (source === "library" && kind && kind !== "garden") continue;

    let names: string[] = [];
    try {
      names = (await fs.readdir(root, { withFileTypes: true }))
        .filter((e) => e.isDirectory()).map((e) => e.name);
    } catch { continue; }   // the user root does not exist until she makes her first one

    for (const name of names) {
      let slug: string;
      try { slug = safeSlug(name); } catch { continue; }   // skip anything oddly named

      const dir = join(root, slug);
      const te = join(dir, `${slug}_te.mp4`);
      if (!await exists(te)) continue;                     // half-rendered: not library yet

      const languages: Array<"te" | "en"> = ["te"];
      if (await exists(join(dir, `${slug}_en.mp4`))) languages.push("en");

      // Titles come from the curated spec for library reels and from the reel's own
      // one-video spec for reels she made.
      let titleTe = "";
      let titleEn = "";
      let itemKind: ReelKind = "garden";
      if (source === "library") {
        titleTe = curated.get(slug)?.title_te ?? "";
        titleEn = curated.get(slug)?.title ?? "";
      } else {
        const own = await readJson<{ videos: SpecVideo[] }>(join(dir, "spec.json"));
        titleTe = own?.videos?.[0]?.title_te ?? "";
        titleEn = own?.videos?.[0]?.title ?? "";
        itemKind = kindOfSpec(own?.videos?.[0]);
      }
      // Decided before the probe and the poster below: each of those is a process spawn,
      // and a hundred reels of the other kind would pay for it and then be dropped.
      if (kind && itemKind !== kind) continue;

      let madeAt: number | null = null;
      try { madeAt = (await fs.stat(te)).mtimeMs; } catch { /* keep null */ }

      items.push({
        slug, kind: itemKind, source, languages, madeAt,
        titleTe: titleTe || titleEn || slug,
        titleEn: titleEn || slug,
        seconds: await probeSeconds(te),
        poster: await ensurePoster(dir, slug),
      });
    }
  }

  // Newest first, and hers ahead of the curated set at equal times -- the one she just made
  // should be the first card she sees.
  items.sort((a, b) => {
    if (a.source !== b.source) return a.source === "made" ? -1 : 1;
    return (b.madeAt ?? 0) - (a.madeAt ?? 0);
  });
  return items;
}

/* ----------------------------------------------------------- admin jobs */

export type ReelJob = {
  slug: string;
  kind: ReelKind;
  titleTe: string;
  titleEn: string;
  typedTip: string;
  understood: string;
  status: "queued" | "running" | "done" | "failed";
  detail: string;
  shotsDone: number;
  shotsTotal: number;
  seconds: number | null;
  sizeMb: number | null;
  updatedAt: number;
  error: string | null;
};

/**
 * Every reel typed through /garden, for the dashboard.
 *
 * Only the user root. The curated fourteen were written by hand and rendered by a batch --
 * they are content, not jobs, and putting them here would bury the one row that actually
 * needs attention under fourteen that never will.
 *
 * "queued" is a real state and worth showing separately from "running": the app starts a
 * render with --wait-for-lock, so a reel can sit for an hour behind a batch with nothing
 * wrong with it. Without the distinction that looks identical to a hang.
 */
export async function listReelJobs(): Promise<ReelJob[]> {
  let names: string[] = [];
  try {
    names = (await fs.readdir(USER_ROOT, { withFileTypes: true }))
      .filter((e) => e.isDirectory()).map((e) => e.name);
  } catch { return []; }

  const jobs: ReelJob[] = [];
  for (const name of names) {
    let slug: string;
    try { slug = safeSlug(name); } catch { continue; }
    const dir = join(USER_ROOT, slug);

    const spec = await readJson<{
      videos: Array<{
        kind?: string; title?: string; title_te?: string; typed_tip?: string;
        understood?: string; shots?: unknown[];
      }>;
    }>(join(dir, "spec.json"));
    const v = spec?.videos?.[0];
    if (!v) continue;                       // a directory with no spec is not a job

    const shotsTotal = v.shots?.length ?? 5;   // 4-6 now, chosen per reel
    let shotsDone = 0;
    for (let i = 1; i <= shotsTotal; i += 1) {
      if (await exists(join(dir, "shots", `shot_${String(i).padStart(2, "0")}.mp4`))) shotsDone += 1;
    }

    const finalTe = join(dir, `${slug}_te.mp4`);
    const done = await exists(finalTe);

    let error: string | null = null;
    if (!done) {
      try {
        const bytes = await fs.readFile(join(dir, "render.err"));
        const text = new TextDecoder("utf-8").decode(bytes).trim();
        if (text) error = text.slice(-400);
      } catch { /* no error file is the normal case */ }
    }

    // Waiting on the lock or the card is not failure. The renderer says so in its log, and
    // that line is the difference between "be patient" and "go and look".
    let waiting = false;
    try {
      const bytes = await fs.readFile(join(dir, "render.log"));
      const log = new TextDecoder("utf-8").decode(bytes);
      const tail = log.slice(-1500);
      waiting = /WAITING FOR GPU|waiting for the run already going/.test(tail)
        && shotsDone === 0;
    } catch { /* no log yet means it has not started */ }

    let seconds: number | null = null;
    let sizeMb: number | null = null;
    let updatedAt = 0;
    try {
      const stat = await fs.stat(done ? finalTe : join(dir, "spec.json"));
      updatedAt = stat.mtimeMs;
      if (done) sizeMb = Math.round((stat.size / 1048576) * 10) / 10;
    } catch { /* keep the nulls */ }
    if (done) seconds = await probeSeconds(finalTe);

    const status: ReelJob["status"] = done ? "done"
      : error ? "failed"
      : waiting ? "queued"
      : "running";
    const detail = done ? `${seconds ?? "?"}s, ${sizeMb ?? "?"} MB`
      : error ? "the render stopped"
      : waiting ? "waiting for the graphics card"
      : `picture ${Math.min(shotsDone + 1, shotsTotal)} of ${shotsTotal}`;

    jobs.push({
      slug,
      kind: kindOfSpec(v),
      titleTe: v.title_te ?? "",
      titleEn: v.title ?? slug,
      typedTip: v.typed_tip ?? "",
      understood: v.understood ?? "",
      status, detail, shotsDone, shotsTotal, seconds, sizeMb, updatedAt, error,
    });
  }

  jobs.sort((a, b) => b.updatedAt - a.updatedAt);
  return jobs;
}

/* ------------------------------------------------------------- progress */

export type ReelProgress = {
  slug: string;
  titleTe: string;
  stage: "idle" | "narrating" | "rendering" | "assembling" | "done" | "failed";
  label: string;
  shotsDone: number;
  shotsTotal: number;
  minutesLeft: number | null;
  ready: boolean;
  video: string | null;
  failed?: string;
};

/**
 * Read progress off the filesystem rather than from a status the renderer has to remember to
 * write. Files on disk are the only thing a power cut cannot lie about, and this machine has
 * had three unclean shutdowns in a day.
 */
export async function readReelProgress(slug: string): Promise<ReelProgress> {
  const dir = reelDir(slug);
  const spec = await readJson<{ videos: Array<{ title_te?: string; shots: unknown[] }> }>(
    join(dir, "spec.json"));
  const video = spec?.videos?.[0];
  const shotsTotal = video?.shots?.length ?? 5;   // 4-6 now, chosen per reel
  const titleTe = video?.title_te ?? "";

  let shotsDone = 0;
  for (let i = 1; i <= shotsTotal; i += 1) {
    if (await exists(join(dir, "shots", `shot_${String(i).padStart(2, "0")}.mp4`))) shotsDone += 1;
  }

  const finalTe = join(dir, `${slug}_te.mp4`);
  const ready = await exists(finalTe);

  // A render that died leaves a non-empty .err and no final file. Surface it rather than
  // spinning forever on a progress bar that will never move.
  let failed: string | undefined;
  if (!ready) {
    try {
      const bytes = await fs.readFile(join(dir, "render.err"));
      const text = new TextDecoder("utf-8").decode(bytes).trim();
      if (text) failed = text.slice(-600);
    } catch { /* no error file is the normal case */ }
  }

  let stage: ReelProgress["stage"] = "idle";
  let label = "Getting ready";
  if (ready) { stage = "done"; label = "Your video is ready"; }
  else if (failed) { stage = "failed"; label = "Something went wrong"; }
  else if (shotsDone >= shotsTotal) { stage = "assembling"; label = "Putting it together"; }
  else if (shotsDone > 0) { stage = "rendering"; label = `Making picture ${shotsDone + 1} of ${shotsTotal}`; }
  else if (await exists(join(dir, "narration"))) { stage = "rendering"; label = `Making picture 1 of ${shotsTotal}`; }
  else if (await exists(join(dir, "render.log"))) { stage = "narrating"; label = "Recording the voice"; }

  // Measured at 0.66 MP: 3.5 min for a 124-frame shot, 6.2 for 175, 7.1 for 192. Reels now
  // run 4-6 short shots, so ~4.5 min each is the honest middle, plus a couple of minutes to
  // narrate and assemble. Stated in minutes because a percentage means nothing to her.
  const remaining = Math.max(0, shotsTotal - shotsDone);
  const minutesLeft = ready ? null : Math.max(1, Math.round(remaining * 4.5 + 2));

  return {
    slug, titleTe, stage, label, shotsDone, shotsTotal, minutesLeft,
    ready, video: ready ? `${slug}_te.mp4` : null, failed,
  };
}

/* ------------------------------------------------------------ in progress */

/**
 * How a live stage is described to the home screen. `idle` and `done` are absent on purpose:
 * neither is work in progress, and both are filtered out before this is consulted, so adding
 * a stage later fails to compile here rather than being silently shown as a render.
 */
const STAGE_SHOWN: Record<"narrating" | "rendering" | "assembling" | "failed",
  MakingItem["stage"]> = {
  narrating: "narrating", rendering: "rendering", assembling: "assembling", failed: "failed",
};

export type MakingItem = {
  slug: string;
  titleTe: string;
  titleEn: string;
  stage: "queued" | "narrating" | "rendering" | "assembling" | "failed";
  shotsDone: number;
  shotsTotal: number;
  minutesLeft: number | null;
  startedAt: number | null;
};

/**
 * The reels being made right now, for the shelf on the home screen.
 *
 * Separate from `listReelJobs`, which is the dashboard's view and ffprobes every finished reel
 * to report its duration and size. There are two hundred finished reels, so doing that on a
 * page that polls would be minutes of work per tick. Here the first test is the cheap one --
 * a reel with a Telugu cut is finished and is skipped on a single stat -- and only the handful
 * that are unfinished cost anything to describe.
 *
 * NO WORDS ARE RETURNED, only a stage and two counts. `readReelProgress` hands back an English
 * label, and /garden opens in Telugu for one reader; composing the sentence on the page is what
 * lets "picture 3 of 5" arrive in the language she is reading. "queued" is folded in here
 * rather than left as "narrating", because a reel waiting behind another render has not
 * started, and saying it is recording the voice for an hour reads as a hang.
 */
export async function listMaking(kind: ReelKind = "garden"): Promise<MakingItem[]> {
  let names: string[] = [];
  try {
    names = (await fs.readdir(USER_ROOT, { withFileTypes: true }))
      .filter((e) => e.isDirectory()).map((e) => e.name);
  } catch { return []; }             // the user root does not exist until the first reel

  const out: MakingItem[] = [];
  for (const name of names) {
    let slug: string;
    try { slug = safeSlug(name); } catch { continue; }     // skip anything oddly named
    const dir = join(USER_ROOT, slug);

    if (await exists(join(dir, `${slug}_te.mp4`))) continue;   // finished; the library has it

    const spec = await readJson<{
      videos: Array<{ kind?: string; title?: string; title_te?: string }>;
    }>(join(dir, "spec.json"));
    const video = spec?.videos?.[0];
    if (!video) continue;            // a folder with no spec is not being made, it is debris
    if (kindOfSpec(video) !== kind) continue;

    let progress: ReelProgress;
    try { progress = await readReelProgress(slug); } catch { continue; }

    // "idle" means a plan was written and never sent to be rendered -- she typed a tip, read
    // the three lines, and closed the page. There are dozens of those, and calling them
    // "being made" put fifty-eight videos on the home screen that nothing was working on.
    // They are not in progress and not finished; they are simply abandoned.
    if (progress.stage === "done" || progress.stage === "idle") continue;

    // Waiting for the card only counts before the first shot lands; after that the log still
    // holds the line from when it was queued, and the reel is plainly moving.
    const stage = progress.stage as keyof typeof STAGE_SHOWN;
    const queued = progress.shotsDone === 0 && stage !== "failed"
      && await waitingForCard(slug);

    let startedAt: number | null = null;
    try { startedAt = (await fs.stat(join(dir, "spec.json"))).mtimeMs; } catch { /* null */ }

    out.push({
      slug,
      titleTe: video.title_te ?? "",
      titleEn: video.title ?? slug,
      // Every stage named, none inferred. The version of this that ended in `: "rendering"`
      // quietly relabelled every abandoned plan as a render in flight.
      stage: queued ? "queued" : STAGE_SHOWN[stage],
      shotsDone: progress.shotsDone,
      shotsTotal: progress.shotsTotal,
      minutesLeft: progress.minutesLeft,
      startedAt,
    });
  }

  // Newest first: the one she just asked for is the one she is looking for.
  out.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  return out;
}

/** reels.py announces a queue in its own log; this reads the line it prints. */
export async function waitingForCard(slug: string): Promise<boolean> {
  try {
    const bytes = await fs.readFile(join(USER_ROOT, safeSlug(slug), "render.log"));
    const log = new TextDecoder("utf-8").decode(bytes);
    return /WAITING FOR GPU|waiting for the run already going/.test(log.slice(-1500));
  } catch { return false; }   // no log yet means it has not started, which is not waiting
}

export type ActiveReel = {
  slug: string;
  kind: ReelKind;
  titleTe: string;
  titleEn: string;
  idea: string;
  stage: ReelProgress["stage"] | "waiting" | "stopped";
  label: string;
  shotsDone: number;
  shotsTotal: number;
  minutesLeft: number | null;
  failed: string | null;
  updatedAt: number;
};

// A rendering reel writes a log line at least every shot, ~7 min at the most. Half an hour
// of silence from one that is not waiting for the card means its process is gone.
const STALLED_AFTER_MS = 30 * 60_000;
// Nothing waits legitimately for longer than the locks allow (two hours), so after three the
// "waiting" line at the end of a log is a dead process that was killed while it waited.
const WAIT_CEILING_MS = 3 * 3600_000;
// A failed or stopped reel stays on the shelf long enough to be seen and carried on, then
// goes, so the shelf does not become a graveyard of old attempts.
const KEEP_FAILED_MS = 24 * 3600_000;

/**
 * When the pipeline last did anything in this folder.
 *
 * NOT the modification time of render.log. That file is held open by the running process and
 * written through a redirected handle, and on this machine its timestamp stays at the moment
 * it was created until the handle closes -- a render forty minutes in, writing merrily, still
 * showed the time it started, and a shelf that trusted it called a healthy render "stopped".
 * Everything below is written and closed each time: state.json is replaced whole after every
 * stage and every shot, fit.json is written once, and the shot and narration folders change
 * whenever a file lands in them. The log's own time is kept only as the floor, for the minute
 * before anything else exists.
 */
async function lastActivity(dir: string): Promise<number> {
  let latest = 0;
  for (const name of ["render.log", "state.json", "fit.json", "shots", "narration"]) {
    try { latest = Math.max(latest, (await fs.stat(join(dir, name))).mtimeMs); } catch { /* absent */ }
  }
  return latest;
}

/**
 * Every reel of this kind that has been started and is not finished, newest first -- the
 * "being made now" shelf on the home screen, so a video started from a phone an hour ago, or
 * from a list, is visible without knowing its address.
 *
 * "Started" means a render.log exists. A plan that was written and never made (she pressed
 * "No, let me write it again", or closed the page) has a spec and nothing else, and is not in
 * progress -- listing those would fill the shelf with abandoned drafts.
 *
 * Read off the filesystem, like everything else here. A render whose process died leaves no
 * note of its own death, so its age is the only evidence: see the three constants above.
 */
export async function listActive(kind?: ReelKind): Promise<ActiveReel[]> {
  let names: string[] = [];
  try {
    names = (await fs.readdir(USER_ROOT, { withFileTypes: true }))
      .filter((e) => e.isDirectory()).map((e) => e.name);
  } catch { return []; }

  const out: ActiveReel[] = [];
  for (const name of names) {
    let slug: string;
    try { slug = safeSlug(name); } catch { continue; }
    const dir = join(USER_ROOT, slug);
    if (await exists(join(dir, `${slug}_te.mp4`))) continue;          // finished: on the shelf

    if (!await exists(join(dir, "render.log"))) continue;              // never started
    const logMtime = await lastActivity(dir);

    const spec = await readJson<{
      videos: Array<{ kind?: string; title?: string; title_te?: string; typed_tip?: string }>;
    }>(join(dir, "spec.json"));
    const v = spec?.videos?.[0];
    if (!v) continue;
    const itemKind = kindOfSpec(v);
    if (kind && itemKind !== kind) continue;

    const progress = await readReelProgress(slug);
    const age = Date.now() - logMtime;
    const waiting = !progress.failed && progress.shotsDone === 0 && age < WAIT_CEILING_MS
      && await waitingForCard(slug);
    const stalled = !progress.failed && !waiting && age > STALLED_AFTER_MS;
    if ((progress.failed || stalled) && age > KEEP_FAILED_MS) continue;

    const stage: ActiveReel["stage"] = waiting ? "waiting" : stalled ? "stopped" : progress.stage;
    const label = waiting ? "Waiting for the graphics card"
      : stalled ? "Stopped before it finished"
      : progress.label;

    out.push({
      slug, kind: itemKind,
      titleTe: v.title_te ?? "", titleEn: v.title ?? "", idea: v.typed_tip ?? "",
      stage, label,
      shotsDone: progress.shotsDone, shotsTotal: progress.shotsTotal,
      minutesLeft: stalled || waiting ? null : progress.minutesLeft,
      failed: progress.failed ?? null,
      updatedAt: logMtime,
    });
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}
