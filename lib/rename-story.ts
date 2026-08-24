/** Give a story folder the story's actual name.
 *
 * A story is filed on disk before anybody knows what it is called. Photographs have to be
 * read first and typed text has no title line at all, so ingest guesses from the opening
 * words -- and the guess is often the first sentence, or a timestamp, or once an instruction
 * she had pasted in by mistake:
 *
 *     ఒక-రోజు-అక్బర్-బీర్బల్-తోటలో-విహరిస్తుంటే-ఒక   was really   అక్బర్, బీర్బల్ ఖిచడి
 *     అనగనగా-ఒక-దేశంలో-ఒక-మహారాజు-ఉండేవారు-ఒకరోజు      was really   మంచి మనసు విలువ
 *     story-1787152754606                              was really   చెడ్డ సావాసం!
 *
 * The real title arrives at the scene-planning stage, and that is the moment to rename: the
 * story is idle, nothing is rendering, and no file has been written that mentions the path.
 *
 * Renaming later would be riskier but is still safe, because although state.json and
 * narration.json both record absolute paths, nothing ever reads them back -- every stage
 * derives its paths from the story directory it was handed. They are rewritten here anyway,
 * so a folder is never left containing paths to a name it no longer has.
 */
import { promises as fs } from "node:fs";
import { STORIES_ROOT, exists, join, readJson, storySlug } from "./story-runner";

type Script = { title?: string; english_title?: string };
type Story = { title?: string; title_english?: string };

/** Is this folder name a guess at the story, rather than its name?
 *
 * Only a guess gets replaced. A dry run over the real library wanted to turn
 * `the-fox-and-the-stork` into `నక్క-మరియు-కొంగ`, because that story predates english_title
 * and the Telugu title was the only one left to fall back to. Renaming a perfectly good
 * folder into one nobody can type is not a fix.
 */
function looksLikeAGuess(name: string): boolean {
  // The timestamp fallback, used when a title slugged to nothing at all.
  if (/^story-\d{10,}$/.test(name)) return true;
  // A title is a few words. Anything this long is a sentence -- the opening line of the
  // story, or once an instruction pasted in by mistake.
  if (name.length > 40) return true;
  return false;
}

/** The name this story should be filed under, or null to leave it as it is. */
export async function wantedName(dir: string): Promise<string | null> {
  const current = dir.slice(dir.lastIndexOf("/") + 1);
  if (!looksLikeAGuess(current)) return null;

  const script = await readJson<Script>(join(dir, "script.json"));
  const story = await readJson<Story>(join(dir, "story.json"));
  // English first, because a Telugu folder name is correct but nobody can type it at a
  // shell. The Telugu title is what the app shows her; this is only the filing.
  const best = (script?.english_title || story?.title_english
                || script?.title || story?.title || "").trim();
  if (!best) return null;
  const slug = storySlug(best);
  if (!slug || slug.startsWith("story-")) return null;
  // Do not swap one sentence-length name for another.
  return looksLikeAGuess(slug) ? null : slug;
}

/** Rewrite absolute paths inside the story's own JSON so none points at the old folder. */
async function repoint(dir: string, from: string, to: string): Promise<void> {
  for (const name of ["state.json", "narration.json", "fit.json", "last-edit.json"]) {
    const file = join(dir, name);
    const bytes = await fs.readFile(file).catch(() => null);
    if (!bytes) continue;
    const text = new TextDecoder("utf-8").decode(bytes);
    // Both separators: these files are written by Python on Windows, so they carry
    // backslashes, while anything written by the app carries forward slashes.
    const fixed = text
      .split(`stories\\\\${from}\\\\`).join(`stories\\\\${to}\\\\`)
      .split(`stories/${from}/`).join(`stories/${to}/`);
    if (fixed !== text) await fs.writeFile(file, fixed, "utf8");
  }
}

export type Renamed = { dir: string; renamed: boolean; from?: string; to?: string };

/**
 * Rename the folder to match the story's real title. Returns where the story now lives --
 * callers MUST use the returned directory, because the one they passed may no longer exist.
 */
export async function renameToTitle(dir: string): Promise<Renamed> {
  const current = dir.slice(dir.lastIndexOf("/") + 1);
  const wanted = await wantedName(dir);
  if (!wanted || wanted === current) return { dir, renamed: false };

  // Never collide with a story that is already there. Two different stories can genuinely
  // share a title, and the second one must not land on top of the first.
  let candidate = wanted;
  for (let n = 2; await exists(join(STORIES_ROOT, candidate)); n += 1) {
    candidate = `${wanted}-${n}`;
    if (n > 50) return { dir, renamed: false };
  }

  const target = join(STORIES_ROOT, candidate);
  try {
    await fs.rename(dir, target);
  } catch {
    // A file inside is open -- a render log, a video being read. Not worth failing the
    // scene plan over; the backfill can pick it up later.
    return { dir, renamed: false };
  }
  await repoint(target, current, candidate);
  return { dir: target, renamed: true, from: current, to: candidate };
}
