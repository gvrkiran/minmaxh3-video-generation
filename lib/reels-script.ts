/**
 * The voice-over script of a reel, read back off its own folder -- and a cut of the reel with
 * no voice on it, for a person who wants to record the lines themselves.
 *
 * Why this exists: the Telugu voice is synthesised, and a synthesised voice is the one part of
 * a finished reel its owner is likeliest to want to replace. Doing that by hand needs three
 * things the pipeline already knows but never writes down in one place: the lines, the window
 * of time each line has to fit inside, and the footage without the synthesised voice on it.
 * This module produces all three from what is already on disk, and spends no graphics card.
 *
 * TIMINGS COME FROM fit.json, NOT FROM THE AUDIO. The renderer cuts every shot to the longer
 * of its two narrations and snaps it onto H3's frame grid, and fit.json records that decision
 * per shot -- so the finished video's shot boundaries are the running sum of `video_seconds`,
 * exact to a frame, and the windows here are the ones a reader has to speak inside. A reel
 * that has been planned but not yet narrated has no fit, and its script comes back untimed.
 * The synthesised voice's own length is reported beside each window, because "the machine
 * said it in 4.9 of the 6.6 seconds" is the most useful thing a person can know before
 * recording the same line.
 *
 * THE NO-VOICE CUT is made on request and cached beside the two narrated cuts, the way the
 * poster is. It is the raw shots joined, with H3's own generated soundtrack kept and brought
 * up to a listenable level -- the track is real (rain, a brush, a bell) but sits near -50 dB,
 * so it is normalised rather than discarded and there is a bed to speak over instead of dead
 * silence. Same encoder settings as the pipeline's join, and the same retry, because this
 * ffmpeg build intermittently dies with 0xC0000005 and succeeds on the identical command a
 * second later. Kind-agnostic on purpose: a painting or a gardening reel gets the same script
 * and the same cut if a page ever asks.
 *
 * The runtime traps of reels-runner.ts apply here too: forward-slash paths throughout, and
 * JSON read through `readJson`, which decodes the bytes itself.
 */
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";

import { exists, join, readJson } from "@/lib/story-runner";
import { kindOfSpec, reelDir, type ReelKind } from "@/lib/reels-runner";

export type ScriptLine = {
  n: number;
  te: string;
  en: string;
  /** Where this shot sits in the finished video, in seconds. Null until the fit exists. */
  start: number | null;
  end: number | null;
  /** How long the synthesised voice actually speaks in each language. Null until narrated. */
  spoken: { te: number | null; en: number | null };
};

export type ReelScript = {
  slug: string;
  kind: ReelKind;
  titleTe: string;
  titleEn: string;
  /** The concept exactly as it was typed, and what the model made of it. */
  typed: string;
  understood: string;
  /** The look the video was made in (`h3_t2v.STYLES` key), or null for a live-action-only genre. */
  style: string | null;
  shots: number;
  /** True when every line carries its window -- the narration has been fitted. */
  timed: boolean;
  totalSeconds: number | null;
  lines: ScriptLine[];
  /** Finished files in the reel folder, by name, or null where one does not exist yet. */
  files: { te: string | null; en: string | null; novoice: string | null };
};

type SpecVideo = {
  slug: string;
  kind?: string;
  title?: string;
  title_te?: string;
  typed_tip?: string;
  understood?: string;
  style?: string;
  shots?: unknown[];
  narration?: { te?: string[]; en?: string[] };
};

type FitRow = {
  index: number;
  frames: number;
  video_seconds: number;
  audio_seconds?: { te?: number; en?: number };
};

const round = (n: number) => Math.round(n * 1000) / 1000;

/**
 * The per-shot fit, from fit.json or from the copy the renderer keeps in state.json. Null when
 * neither exists, which is the ordinary state of a reel between its plan and its narration.
 */
async function readFit(dir: string): Promise<FitRow[] | null> {
  const fit = await readJson<{ shots?: FitRow[] }>(join(dir, "fit.json"));
  if (fit?.shots?.length) return fit.shots;
  const state = await readJson<{ fit?: FitRow[] }>(join(dir, "state.json"));
  return state?.fit?.length ? state.fit : null;
}

/**
 * The script of one reel she made, timed where the fit exists.
 *
 * Only the user root: every reel with a spec of its own lives there, and the curated set has no
 * per-reel spec to read lines from. `reelDir` validates the slug and confines the path.
 */
export async function readReelScript(slug: string): Promise<ReelScript> {
  const dir = reelDir(slug);
  const spec = await readJson<{ videos: SpecVideo[] }>(join(dir, "spec.json"));
  const video = spec?.videos?.[0];
  if (!video) throw new Error("That video is not one this studio made.");

  const te = video.narration?.te ?? [];
  const en = video.narration?.en ?? [];
  const shots = video.shots?.length ?? Math.max(te.length, en.length);
  const fit = await readFit(dir);
  const byIndex = new Map((fit ?? []).map((row) => [row.index, row]));

  // Windows are the running sum of the fitted shot lengths, in shot order -- exactly how the
  // join stage lays the narrated shots end to end.
  const lines: ScriptLine[] = [];
  let clock = 0;
  let timed = fit !== null && shots > 0;
  for (let i = 1; i <= shots; i += 1) {
    const row = byIndex.get(i);
    if (!row) timed = false;
    const start = row ? round(clock) : null;
    const end = row ? round(clock + row.video_seconds) : null;
    if (row) clock += row.video_seconds;
    lines.push({
      n: i,
      te: te[i - 1] ?? "",
      en: en[i - 1] ?? "",
      start, end,
      spoken: {
        te: row?.audio_seconds?.te ?? null,
        en: row?.audio_seconds?.en ?? null,
      },
    });
  }

  const cutTe = `${slug}_te.mp4`;
  const cutEn = `${slug}_en.mp4`;
  const cutNoVoice = `${slug}_novoice.mp4`;
  const files = {
    te: await exists(join(dir, cutTe)) ? cutTe : null,
    en: await exists(join(dir, cutEn)) ? cutEn : null,
    novoice: await ensureNoVoiceCut(dir, slug, shots) ? cutNoVoice : null,
  };

  return {
    slug,
    kind: kindOfSpec(video),
    titleTe: video.title_te ?? "",
    titleEn: video.title ?? slug,
    typed: video.typed_tip ?? "",
    understood: video.understood ?? "",
    style: video.style ?? null,
    shots,
    timed,
    totalSeconds: timed ? round(clock) : null,
    lines,
    files,
  };
}

/* ------------------------------------------------------------ no-voice cut */

// One ffmpeg per reel at a time. The done screen and the library can ask for the same reel's
// script within the same second, and two ffmpegs racing to the same output name is how a
// half-written file ends up served as a video.
const inflight = new Map<string, Promise<boolean>>();

/**
 * Make sure `<slug>_novoice.mp4` exists, if the shots to make it from do. Returns whether it
 * exists afterwards. Cached by existence, like everything else in a reel folder.
 */
export function ensureNoVoiceCut(dir: string, slug: string, shots: number): Promise<boolean> {
  const key = `${dir}|${slug}`;
  const running = inflight.get(key);
  if (running) return running;
  const job = makeNoVoiceCut(dir, slug, shots).finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

async function makeNoVoiceCut(dir: string, slug: string, shots: number): Promise<boolean> {
  const out = join(dir, `${slug}_novoice.mp4`);
  if (await exists(out)) return true;
  if (shots < 1) return false;

  const parts: string[] = [];
  for (let i = 1; i <= shots; i += 1) {
    const part = join(dir, "shots", `shot_${String(i).padStart(2, "0")}.mp4`);
    if (!await exists(part)) return false;       // still rendering; nothing to join yet
    parts.push(part);
  }

  // Same listing shape the pipeline writes for its own joins: forward-slash absolute paths,
  // which the concat demuxer accepts with -safe 0.
  const listing = join(dir, "concat_novoice.txt");
  await fs.writeFile(listing, parts.map((p) => `file '${p}'\n`).join(""), "utf8");

  // Written under a temporary name and renamed at the end, so a crash mid-encode can never
  // leave a truncated file that passes the existence check above.
  const tmp = join(dir, `${slug}_novoice.tmp.mp4`);
  const common = [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "concat", "-safe", "0", "-i", listing,
    "-c:v", "libx264", "-preset", "medium", "-crf", "19", "-pix_fmt", "yuv420p",
  ];
  const withAmbience = [
    ...common,
    "-af", "loudnorm=I=-18:TP=-1.5:LRA=11",
    "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", tmp,
  ];
  // A shot with no audio stream at all makes the filter fail outright; keep the picture and
  // hand back a silent cut rather than nothing.
  const silent = [...common, "-an", "-movflags", "+faststart", tmp];

  let made = await ffmpegRetry(withAmbience);
  if (!made) made = await ffmpegRetry(silent, 1);
  if (!made) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    return false;
  }
  await fs.rename(tmp, out);
  return true;
}

function runFfmpeg(args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn("ffmpeg", args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr?.on("data", (c) => { err += String(c); });
    child.on("error", () => resolve(-1));
    child.on("close", (code) => {
      if (code !== 0 && err.trim()) {
        console.warn(`[reels-script] ffmpeg exit ${code}: ${err.trim().slice(-400)}`);
      }
      resolve(code ?? -1);
    });
  });
}

/** The pipeline's `run_cmd`, in Node: this ffmpeg build crashes and then succeeds on retry. */
async function ffmpegRetry(args: string[], attempts = 3): Promise<boolean> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (await runFfmpeg(args) === 0) return true;
    if (attempt < attempts) await new Promise((r) => setTimeout(r, 2000 * attempt));
  }
  return false;
}

/* -------------------------------------------------------------- formats */

/** `0:06.6` -- what a person reads off while recording. */
export function clockShort(seconds: number): string {
  const whole = Math.floor(seconds);
  const tenths = Math.round((seconds - whole) * 10);
  const m = Math.floor(whole / 60);
  const s = whole % 60;
  return `${m}:${String(s).padStart(2, "0")}.${Math.min(9, tenths)}`;
}

/** `00:00:06,583` -- what a subtitle file wants. */
function clockSrt(seconds: number): string {
  const ms = Math.round(seconds * 1000);
  const h = Math.floor(ms / 3600_000);
  const m = Math.floor((ms % 3600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const rest = ms % 1000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:`
    + `${String(s).padStart(2, "0")},${String(rest).padStart(3, "0")}`;
}

/**
 * The script as one plain-text file: both languages, every window, and what the concept was.
 * Leads with a byte-order mark so any Windows editor opens the Telugu as Telugu.
 */
export function scriptAsText(script: ReelScript): string {
  const out: string[] = ["﻿" + (script.titleTe || script.titleEn), script.titleEn, ""];
  if (script.typed) out.push("As typed:", `  ${script.typed}`, "");
  if (script.understood) out.push("The plan:", `  ${script.understood}`, "");
  if (script.timed && script.totalSeconds !== null) {
    out.push(`${script.shots} shots, ${script.totalSeconds.toFixed(1)} seconds in all.`);
    out.push("Each line is spoken over one shot. To record it in your own voice, read each "
      + "line inside its window; the second figure is how long the machine took to say it.");
  } else {
    out.push(`${script.shots} shots. The windows appear here once the video has been made.`);
  }
  out.push("");
  for (const line of script.lines) {
    let head = `${line.n}.`;
    if (line.start !== null && line.end !== null) {
      head += `  ${clockShort(line.start)} - ${clockShort(line.end)}  (${(line.end - line.start).toFixed(1)} s`;
      const spoken = line.spoken.te;
      if (spoken !== null) head += `; the voice takes ${spoken.toFixed(1)} s`;
      head += ")";
    }
    out.push(head);
    out.push(`    తెలుగు:  ${line.te}`);
    out.push(`    English: ${line.en}`);
    out.push("");
  }
  return out.join("\r\n");
}

/**
 * One language as SubRip subtitles, one cue per shot spanning its whole window. Loaded next to
 * the no-voice cut in any player, the cue on screen is the line to be reading right then.
 */
export function scriptAsSrt(script: ReelScript, lang: "te" | "en"): string {
  const cues: string[] = [];
  for (const line of script.lines) {
    if (line.start === null || line.end === null) continue;
    // A hair short of the boundary, so consecutive cues never overlap by a millisecond.
    const end = Math.max(line.start, line.end - 0.05);
    cues.push(`${line.n}\r\n${clockSrt(line.start)} --> ${clockSrt(end)}\r\n${line[lang]}\r\n`);
  }
  return "﻿" + cues.join("\r\n");
}
