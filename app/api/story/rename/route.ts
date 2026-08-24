/** Re-file stories that were named from a guess instead of their title.
 *
 * New stories are renamed automatically once the scene plan gives them a real title. This is
 * for the ones made before that existed -- named from the opening words of pasted text, or
 * from a timestamp, or once from an instruction pasted in by mistake.
 *
 * It lives here rather than in a standalone script so it uses the same renameToTitle() the
 * pipeline uses; a second copy of the naming rules would drift from the first.
 *
 *   GET  /api/story/rename           what it would do, changing nothing
 *   POST /api/story/rename           do it
 *
 * A story with a live driver is never touched. Renaming under a running render would leave
 * it writing into a directory that no longer answers to that name.
 */
import { promises as fs } from "node:fs";
import { STORIES_ROOT, exists, fail, join, readJson } from "@/lib/story-runner";
import { renameToTitle, wantedName } from "@/lib/rename-story";

export const dynamic = "force-dynamic";

function alive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (caught) {
    return (caught as { code?: string }).code === "EPERM";
  }
}

async function survey(apply: boolean) {
  const names = (await fs.readdir(STORIES_ROOT).catch(() => [] as string[])).sort();
  const planned: Array<{ from: string; to: string; done: boolean; why?: string }> = [];
  let alreadyRight = 0;

  for (const name of names) {
    const dir = join(STORIES_ROOT, name);
    const stat = await fs.stat(dir).catch(() => null);
    if (!stat?.isDirectory()) continue;
    if (name.startsWith("_incoming-")) continue;      // never became a story

    const lock = await readJson<{ pid?: number }>(join(dir, "pipeline.lock"));
    if (alive(lock?.pid)) {
      planned.push({ from: name, to: name, done: false, why: "being worked on right now" });
      continue;
    }

    const wanted = await wantedName(dir);
    if (!wanted || wanted === name) { alreadyRight += 1; continue; }

    if (!apply) {
      const taken = await exists(join(STORIES_ROOT, wanted));
      planned.push({ from: name, to: wanted, done: false,
                     why: taken ? "name taken, would get a suffix" : undefined });
      continue;
    }
    const result = await renameToTitle(dir);
    planned.push(result.renamed
      ? { from: result.from!, to: result.to!, done: true }
      : { from: name, to: wanted, done: false, why: "a file inside is open" });
  }
  return { planned, alreadyRight };
}

export async function GET() {
  try {
    const { planned, alreadyRight } = await survey(false);
    return Response.json({
      dryRun: true, wouldRename: planned.length, alreadyCorrect: alreadyRight, stories: planned,
    });
  } catch (caught) {
    return fail("Check the story folders", caught, { status: 500 });
  }
}

export async function POST() {
  try {
    const { planned, alreadyRight } = await survey(true);
    const done = planned.filter((p) => p.done);
    return Response.json({
      renamed: done.length, alreadyCorrect: alreadyRight,
      skipped: planned.filter((p) => !p.done),
      stories: done,
    });
  } catch (caught) {
    return fail("Rename the story folders", caught, { status: 500 });
  }
}
