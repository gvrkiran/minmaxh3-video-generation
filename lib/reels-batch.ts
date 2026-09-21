/**
 * Batches: a list of typed ideas taken straight through to finished reels, no approval step.
 *
 * A companion to reels-runner.ts, not a replacement. The single-reel path exists so one
 * person can see three lines of narration before spending twenty minutes of graphics card on
 * them; that check is worth having and is not being removed. This path exists for the
 * opposite case -- a list written in advance, where the point is to start it and walk away.
 *
 * The app OWNS NO WORK HERE. It creates a folder, writes batch.json, and starts a detached
 * `batch_reels.py`, which is the thing that actually walks the list. Everything read back
 * comes off the filesystem. That split is deliberate: a batch of ten ideas runs for about
 * four hours, and over that window this dev server will very likely be restarted and this
 * machine may well bugcheck (the 0x3B ones). Work that lives inside a request does not
 * survive either; work that lives in a detached process and a state file survives both.
 *
 * The same three runtime traps from reels-runner.ts apply -- POSIX `node:path`, Latin-1
 * `readFile(..., "utf8")`, and unbuffered python -- and are handled the same way.
 */
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";

import { join, normalisePath, exists } from "@/lib/story-runner";
import {
  REELS_ROOT, USER_ROOT, newSlug, readReelProgress, waitingForCard,
  type ReelKind, type ReelProgress,
} from "@/lib/reels-runner";

/** Sibling of `user/`, so nothing that walks the reel folders has to know about batches. */
export const BATCH_ROOT = `${REELS_ROOT}/batches`;

const TOOLS_PY = "H:/KathaluStudio/ocr-venv/Scripts/python.exe";
const DRIVER = `${REELS_ROOT}/batch_reels.py`;

/**
 * The ceiling on one paste. Not a technical limit -- it is a bill.
 *
 * A reel is about 25 minutes of graphics card and one OpenAI call, so 25 ideas is roughly
 * ten hours of card and a few dollars of API. Past that a typo in a paste stops being a
 * mistake and starts being a night. The number is shown on the page next to the estimate so
 * it is never a surprise.
 */
export const MAX_IDEAS = 25;
/**
 * The ceiling on a list that keeps growing. Lines typed while a list is running join its end
 * (see `appendToBatch`), so the paste cap alone no longer bounds a night of graphics card.
 */
export const MAX_QUEUE = 60;
/** Measured: 4-6 shots at ~4.5 min, plus narration and assembly. */
export const MINUTES_PER_REEL = 25;

/**
 * The shortest line worth spending a reel on. A gardening tip under ten characters is not a
 * tip; a painting idea can be one word -- "kingfisher" -- and the model does the rest.
 */
const MIN_IDEA_CHARS: Record<ReelKind, number> = { garden: 10, paint: 3, concept: 3 };
const MAX_IDEA_CHARS = 600;

export type BatchItemStatus = "pending" | "planning" | "rendering" | "done" | "failed";

export type BatchItem = {
  n: number;
  idea: string;
  slug: string;
  /** Absent on lists made before there was a second kind; those were all gardening. */
  kind?: ReelKind;
  status: BatchItemStatus;
  titleTe: string;
  titleEn: string;
  understood: string;
  error: string | null;
  startedAt: number | null;
  finishedAt: number | null;
};

export type BatchState = {
  id: string;
  /** Absent on lists made before there was a second kind; those were all gardening. */
  kind?: ReelKind;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  status: "running" | "done" | "failed" | "stopped";
  pid: number | null;
  error?: string;
  items: BatchItem[];
};

/** What the page renders: the state file, plus whatever the filesystem says right now. */
export type BatchView = BatchState & {
  /** "running" only if a live process is behind it -- see `driverAlive`. */
  live: boolean;
  counts: { done: number; failed: number; pending: number; total: number };
  minutesLeft: number | null;
  /** Live shot progress for the item being rendered; null for every other state. */
  current: (ReelProgress & { n: number }) | null;
};

/* ----------------------------------------------------------------- input */

/**
 * One idea per line. Blank lines and `#` comments are dropped so a list can be kept in a
 * text file with notes in it, which is how a list of twenty actually gets written.
 *
 * Duplicates are dropped too, case-insensitively: pasting the same line twice is a paste
 * error, and honouring it costs 25 minutes of card to make the same video again.
 */
export function parseIdeas(
  input: unknown, minChars: number = MIN_IDEA_CHARS.garden,
): { ideas: string[]; skipped: string[] } {
  const skipped: string[] = [];
  const seen = new Set<string>();
  const ideas: string[] = [];

  for (const raw of String(input ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    if (line.length < minChars) { skipped.push(`Too short: "${line}"`); continue; }
    if (line.length > MAX_IDEA_CHARS) {
      skipped.push(`Too long (${line.length} letters): "${line.slice(0, 50)}..."`);
      continue;
    }
    const key = line.toLowerCase();
    if (seen.has(key)) { skipped.push(`Repeated: "${line.slice(0, 50)}"`); continue; }

    seen.add(key);
    ideas.push(line);
  }
  return { ideas, skipped };
}

/* ----------------------------------------------------------------- paths */

export function safeBatchId(input: unknown): string {
  const value = String(input ?? "").trim();
  if (!/^b-[a-z0-9]+$/.test(value) || value.length > 32) {
    throw new Error("That is not a list this studio made.");
  }
  return value;
}

function batchDir(id: string): string {
  const dir = join(BATCH_ROOT, safeBatchId(id));
  if (!dir.startsWith(`${normalisePath(BATCH_ROOT)}/`)) throw new Error("Invalid list.");
  return dir;
}

/**
 * Read a JSON file that may be mid-rewrite.
 *
 * Deliberately not story-runner's `readJson`: the driver replaces batch.json after every
 * transition, and although the write is atomic, a read landing in the same millisecond on
 * exFAT has been seen to come back empty. One retry costs nothing and removes a class of
 * flicker on a page that polls every few seconds.
 *
 * Bytes then TextDecoder, never `readFile(..., "utf8")` -- this runtime decodes that as
 * Latin-1 and turns every Telugu title into mojibake.
 */
async function readState(file: string): Promise<BatchState | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const text = new TextDecoder("utf-8").decode(await fs.readFile(file)).trim();
      if (text) return JSON.parse(text) as BatchState;
    } catch { /* fall through to the retry, then give up */ }
  }
  return null;
}

/* ------------------------------------------------------------- processes */

/**
 * Is the pid in batch.json still a live process?
 *
 * Needed because a batch killed by a bugcheck leaves `status: "running"` on disk forever,
 * and a page that says "running" about a process that died in the night is worse than one
 * that says nothing. `tasklist` is what the Python side already uses for the same question,
 * so the two agree.
 */
function driverAlive(pid: number | null | undefined): Promise<boolean> {
  if (!pid || pid <= 0) return Promise.resolve(false);
  return new Promise((resolve) => {
    const child = spawn("tasklist", ["/FI", `PID eq ${pid}`, "/NH"],
      { windowsHide: true });
    let out = "";
    child.stdout.on("data", (c) => { out += String(c); });
    child.on("error", () => resolve(false));
    // tasklist prints "INFO: No tasks..." rather than failing, so match on the pid itself.
    child.on("close", () => resolve(out.includes(String(pid))));
  });
}

/** Start the driver detached, with its own log, exactly as a render is started. */
async function startDriver(dir: string): Promise<number | undefined> {
  const log = await fs.open(join(dir, "batch.log"), "a");
  const err = await fs.open(join(dir, "batch.err"), "a");
  const child = spawn(TOOLS_PY, ["-u", DRIVER, "--batch", dir], {
    cwd: REELS_ROOT,
    env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUNBUFFERED: "1" },
    detached: true,
    windowsHide: true,
    stdio: ["ignore", log.fd, err.fd],
  });
  child.unref();
  return child.pid;
}

/**
 * Start the driver and record that it is running, without waiting for it to say so itself.
 *
 * The driver writes its own pid as its first act, but python takes a couple of hundred
 * milliseconds to get there, and a response built inside that window reported the batch it
 * had just started as already dead. Writing the spawned pid here closes it, for the response
 * and for any poll that beats the driver to the file.
 *
 * Re-reads immediately before writing, so that if the driver did win the race its copy is
 * the one kept and only the pid and the running status are carried across.
 */
async function launch(dir: string, fallback: BatchState): Promise<void> {
  const pid = (await startDriver(dir)) ?? null;
  const state = await readState(join(dir, "batch.json")) ?? fallback;
  state.pid = state.pid ?? pid;
  state.status = "running";
  await fs.writeFile(join(dir, "batch.json"), JSON.stringify(state, null, 2), "utf8");
}

/* --------------------------------------------------------------- the API */

/**
 * The batch currently holding the machine, if any.
 *
 * Only one runs at a time. Not because two would corrupt anything -- `RunLock` serialises
 * the renders regardless -- but because a second batch would interleave with the first, and
 * "your list is running" stops being answerable when there are two lists.
 */
export async function activeBatch(): Promise<BatchView | null> {
  for (const view of await listBatches()) {
    if (view.live) return view;
  }
  return null;
}

export async function createBatch(
  ideasInput: unknown, kind: ReelKind = "garden",
): Promise<{ id: string; skipped: string[]; appended?: number }> {
  const { ideas, skipped } = parseIdeas(ideasInput, MIN_IDEA_CHARS[kind]);
  if (!ideas.length) {
    // "There are no ideas in that list" is a lie when there were ten lines and every one of
    // them was dropped. Say which, or a rejected paste reads as one that was ignored.
    throw new Error(skipped.length
      ? `None of those lines could be used. ${skipped.slice(0, 4).join(" ")}`
        + (skipped.length > 4 ? ` ...and ${skipped.length - 4} more.` : "")
      : "There are no ideas in that list yet. Write one per line.");
  }
  if (ideas.length > MAX_IDEAS) {
    throw new Error(`That is ${ideas.length} ideas. ${MAX_IDEAS} at a time is the most, `
      + `because each one takes about ${MINUTES_PER_REEL} minutes to make.`);
  }

  const running = await activeBatch();
  if (running) {
    // A list is already going: the new lines join its end rather than being refused. One
    // graphics card is one queue, whatever page the lines came from, and "wait for it to
    // finish" was no answer to someone who had just typed three more ideas.
    const added = await appendToBatch(running.id, ideas, kind);
    return { id: running.id, skipped: [...skipped, ...added.skipped], appended: added.count };
  }

  const stamp = Date.now().toString(36);
  const id = `b-${stamp}`;
  const dir = batchDir(id);
  await fs.mkdir(dir, { recursive: true });

  const state: BatchState = {
    id,
    kind,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    status: "running",
    pid: null,
    // Slugs are minted here rather than from the model's title, so that the folder exists
    // before the plan does and a crash between the two leaves nothing half-named. Same
    // shape the approved path uses, which is what makes these reels show up in the page's
    // library and the admin dashboard with no change to either.
    //
    // The kind sits on every item as well as on the list: a retry list gathers items from
    // several lists, and the driver reads the item's kind first.
    items: ideas.map((idea, i) => ({
      n: i + 1,
      idea,
      kind,
      slug: newSlug(kind, `${stamp}${(i + 1).toString(36)}`),
      status: "pending" as const,
      titleTe: "", titleEn: "", understood: "",
      error: null, startedAt: null, finishedAt: null,
    })),
  };
  await fs.writeFile(join(dir, "batch.json"), JSON.stringify(state, null, 2), "utf8");

  await launch(dir, state);
  return { id, skipped };
}

/**
 * Add lines to the end of a list that is already running.
 *
 * The driver re-reads batch.json before every turn and adopts any slug it has not seen, so a
 * live one picks these up on its own; the file is the queue. Items carry their own kind, so a
 * concept can join a list that started as paintings -- each page then shows only its own
 * lines (`view` filters by kind). The one race worth naming: if the driver finished in the
 * moment between the liveness check and this write, nothing would ever read the new lines, so
 * the driver is started again afterwards when it is found dead -- resume skips everything
 * already made and lands straight on them.
 */
async function appendToBatch(
  id: string, ideas: string[], kind: ReelKind,
): Promise<{ count: number; skipped: string[] }> {
  const dir = batchDir(id);
  const state = await readState(join(dir, "batch.json"));
  if (!state) throw new Error("That list is not one this studio made.");

  const have = new Set(state.items.map((i) => i.idea.trim().toLowerCase()));
  const skipped: string[] = [];
  const fresh: string[] = [];
  for (const idea of ideas) {
    const key = idea.toLowerCase();
    if (have.has(key)) { skipped.push(`Already in the list: "${idea.slice(0, 50)}"`); continue; }
    have.add(key);
    fresh.push(idea);
  }
  if (!fresh.length) {
    throw new Error(skipped.length
      ? "Those lines are already in the list being made."
      : "There are no ideas in that list yet. Write one per line.");
  }
  if (state.items.length + fresh.length > MAX_QUEUE) {
    throw new Error(`The list already has ${state.items.length} videos in it; `
      + `${MAX_QUEUE} at a time is the most.`);
  }

  const stamp = Date.now().toString(36);
  fresh.forEach((idea, i) => {
    state.items.push({
      n: state.items.length + 1,
      idea,
      kind,
      slug: newSlug(kind, `${stamp}${(i + 1).toString(36)}`),
      status: "pending",
      titleTe: "", titleEn: "", understood: "",
      error: null, startedAt: null, finishedAt: null,
    });
  });
  state.updatedAt = Date.now();
  await fs.writeFile(join(dir, "batch.json"), JSON.stringify(state, null, 2), "utf8");

  if (!await driverAlive(state.pid)) await launch(dir, state);
  return { count: fresh.length, skipped };
}

/**
 * Restart the driver over an existing list.
 *
 * Serves both "the machine rebooted at idea four" and "two of them failed, try again". The
 * driver is resumable, so this is the same operation in both cases: anything with a finished
 * mp4 is skipped, anything with a spec keeps it, and only the missing work is redone.
 */
export async function resumeBatch(id: string): Promise<void> {
  const dir = batchDir(id);
  const state = await readState(join(dir, "batch.json"));
  if (!state) throw new Error("That list is not one this studio made.");
  if (await driverAlive(state.pid)) throw new Error("That list is already being made.");

  const running = await activeBatch();
  if (running && running.id !== id) {
    throw new Error("Another list is being made. Wait for it to finish, or stop it first.");
  }
  await launch(dir, state);
}

/**
 * Stop a running batch.
 *
 * `/T` matters: the driver's child is the render, and killing only the parent leaves a
 * `reels.py` holding the graphics card with nothing left to report to. Killed mid-shot the
 * work is not lost -- finished shots stay on disk and a resume carries on from there.
 */
export async function stopBatch(id: string): Promise<void> {
  const dir = batchDir(id);
  const state = await readState(join(dir, "batch.json"));
  if (!state) throw new Error("That list is not one this studio made.");

  if (state.pid) {
    await new Promise<void>((resolve) => {
      const child = spawn("taskkill", ["/PID", String(state.pid), "/T", "/F"],
        { windowsHide: true });
      child.on("error", () => resolve());
      child.on("close", () => resolve());
    });
  }
  state.status = "stopped";
  state.pid = null;
  state.updatedAt = Date.now();
  for (const item of state.items) {
    if (item.status === "planning" || item.status === "rendering") item.status = "pending";
  }
  await fs.writeFile(join(dir, "batch.json"), JSON.stringify(state, null, 2), "utf8");
}

/**
 * Every unfinished item from every list, gathered into one new list and run in order.
 *
 * Resume only reaches inside one list, and failures scatter across all of them -- five spread
 * over three lists meant three sequential resumes, each waiting on the one before. This is the
 * button for "just try all of them again".
 *
 * THE ITEMS KEEP THEIR ORIGINAL SLUGS, which is the whole trick and the reason this is cheap.
 * The driver skips planning when a spec.json already exists and `reels.py` skips every shot
 * already rendered, so a retry costs only the work that is actually missing: a reel that died
 * at the final join re-joins in a minute, and only an item whose plan never got written pays
 * for another model call. Reusing the slug also means the original lists heal themselves --
 * `view()` trusts the mp4 over the state file, so the moment this run produces one, the item
 * shows as done on the list it originally failed on too.
 */
export async function retryAllFailed(
  kind?: ReelKind,
): Promise<{ id: string; count: number; skipped: string[] }> {
  const running = await activeBatch();
  if (running) {
    throw new Error("A list is already being made. Wait for it to finish, or stop it first.");
  }

  const seen = new Set<string>();
  const gathered: BatchItem[] = [];
  const skipped: string[] = [];
  // Each page retries its own kind. The items keep their own kind either way, so the driver
  // writes any missing plan in the right genre even on a list that mixes them.
  for (const batch of await listBatches(kind)) {      // newest first
    for (const item of batch.items) {
      // `listBatches` has already re-checked the filesystem, so "done" here means an mp4
      // really exists. Deduplicated by slug: an item retried once already appears on both
      // its original list and the retry list, and must not be queued twice.
      if (item.status === "done" || seen.has(item.slug)) continue;
      seen.add(item.slug);
      if (gathered.length >= MAX_IDEAS) { skipped.push(item.idea); continue; }
      gathered.push({
        ...item,
        n: gathered.length + 1,
        status: "pending",
        error: null, startedAt: null, finishedAt: null,
      });
    }
  }
  if (!gathered.length) {
    throw new Error("Nothing to retry -- every video on every list is made.");
  }

  const id = `b-${Date.now().toString(36)}`;
  const dir = batchDir(id);
  await fs.mkdir(dir, { recursive: true });
  const state: BatchState = {
    id,
    kind,
    createdAt: Date.now(), updatedAt: Date.now(),
    startedAt: null, finishedAt: null,
    status: "running", pid: null,
    items: gathered,
  };
  await fs.writeFile(join(dir, "batch.json"), JSON.stringify(state, null, 2), "utf8");
  await launch(dir, state);
  return { id, count: gathered.length, skipped };
}

/** One batch, reconciled against the filesystem and the process table. */
export async function readBatch(id: string): Promise<BatchView> {
  const dir = batchDir(id);
  const state = await readState(join(dir, "batch.json"));
  if (!state) throw new Error("That list is not one this studio made.");
  return view(state);
}

/** The kind an item is, for lists made before items carried one. */
function itemKind(item: BatchItem, state: BatchState): ReelKind {
  return item.kind ?? state.kind ?? "garden";
}

async function view(state: BatchState, kind?: ReelKind): Promise<BatchView> {
  // A batch with no pid on it yet is starting, not dead. Backstop for the same race as
  // above -- one minute is far longer than a python start and far shorter than a shot.
  const starting = state.status === "running" && !state.pid
    && Date.now() - state.createdAt < 60_000;
  const live = state.status === "running" && (starting || await driverAlive(state.pid));

  // Trust the files over the state file. The driver writes after every transition, but a
  // bugcheck lands between two of them often enough on this machine that a finished video
  // marked "rendering" is a real case, not a hypothetical one.
  //
  // BOTH cuts are required, and a stored "done" does not override them. One reel kept its
  // Telugu cut and lost only the English join to a transient crash; because the Telugu file
  // was there it read as finished everywhere and the retry sweep skipped it. Judging on both
  // makes that reel show as unfinished, which is what gets it picked up and re-joined.
  for (const item of state.items) {
    const made = await Promise.all(["te", "en"].map(
      (lang) => exists(join(USER_ROOT, item.slug, `${item.slug}_${lang}.mp4`))));
    item.status = made.every(Boolean) ? "done"
      : item.status === "done" ? "failed"   // it says done but a file is gone
      : item.status;
  }

  // With a kind, only that kind's lines are shown and counted. One queue serves every page
  // since lines can be added to a running list from any of them, and a painting page has
  // nothing to say about the concepts someone queued behind its paintings.
  const items = kind ? state.items.filter((i) => itemKind(i, state) === kind) : state.items;

  const counts = {
    done: items.filter((i) => i.status === "done").length,
    failed: items.filter((i) => i.status === "failed").length,
    pending: items.filter((i) => i.status === "pending").length,
    total: items.length,
  };

  // Shot-level progress, for the one item actually on the card. Reuses /garden's reader, so
  // the two pages cannot drift apart on what "picture 3 of 5" means.
  let current: BatchView["current"] = null;
  const running = items.find((i) => i.status === "rendering" || i.status === "planning");
  if (running) {
    try {
      current = { ...await readReelProgress(running.slug), n: running.n };
      // A batch queues behind the curated watchdog and behind anything started from /garden,
      // and it can sit there for an hour. readReelProgress has no word for that and reports
      // the first stage instead, so a queued reel claimed to be "recording the voice" the
      // whole time. That line is the difference between "be patient" and "go and look" --
      // and on this page, unlike /garden, queueing is the normal case rather than the rare
      // one. Same two markers `listReelJobs` reads, so the dashboard and this agree.
      if (current.shotsDone === 0 && await waitingForCard(running.slug)) {
        current = { ...current, label: "Waiting for the graphics card" };
      }
    } catch { /* the folder may not exist yet during planning; the row still renders */ }
  }

  const left = counts.total - counts.done - counts.failed;
  const minutesLeft = live && left > 0
    ? Math.max(1, left * MINUTES_PER_REEL - (current ? current.shotsDone * 4.5 : 0))
    : null;

  return {
    ...state,
    items,
    // A batch whose driver died is not running, whatever the file says.
    status: state.status === "running" && !live ? "stopped" : state.status,
    live, counts,
    minutesLeft: minutesLeft === null ? null : Math.round(minutesLeft),
    current,
  };
}

/**
 * Every batch, newest first. With a `kind`, only the lists holding lines of that kind, each
 * shown as that kind's lines alone -- a list that started as paintings and had concepts added
 * appears on both pages, each seeing its own.
 */
export async function listBatches(kind?: ReelKind): Promise<BatchView[]> {
  let names: string[] = [];
  try {
    names = (await fs.readdir(BATCH_ROOT, { withFileTypes: true }))
      .filter((e) => e.isDirectory()).map((e) => e.name);
  } catch { return []; }   // the root does not exist until the first list is made

  const out: BatchView[] = [];
  for (const name of names) {
    let dir: string;
    try { dir = batchDir(name); } catch { continue; }   // skip anything oddly named
    const state = await readState(join(dir, "batch.json"));
    if (!state) continue;
    // Lists made before there was a second kind carry none, and were all gardening.
    if (kind && !state.items.some((i) => itemKind(i, state) === kind)) continue;
    out.push(await view(state, kind));
  }
  out.sort((a, b) => b.createdAt - a.createdAt);
  return out;
}
