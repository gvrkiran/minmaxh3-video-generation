/** Kiran's dashboard. Everything running, waiting, finished, broken -- and what she asked for.
 *
 * Not the same audience as /story, so not the same design. /story hides every mechanism
 * because it is for someone who does not want to know about models. This shows the
 * mechanism, because it exists to answer "why is that stuck" and "what did that cost".
 *
 * No password, as asked. What actually gates access is that it only listens on the Tailscale
 * address -- so it is reachable from his devices and nothing else. Worth knowing rather than
 * assuming, because the page will happily show anyone who reaches it the whole library.
 *
 * Client-rendered and polled rather than server-rendered: the interesting states change while
 * you watch them, and a dashboard you have to reload is a dashboard you stop trusting.
 */
"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import "./admin.css";

type Edit = { scene: number; asked: string; kind: string };
type Job = {
  name: string; title: string; englishTitle: string; language: string;
  status: string; detail: string;
  pages: number; scenes: number; shotsDone: number; audioDone: number;
  scenesOverCap: number | null; aspect: string | null;
  finishedAt: number | null; sizeMb: number | null; updatedAt: number;
  readSeconds: number | null; recovered: number | null; columns: number | null;
  photoComplete: boolean | null; filledSpans: number; noteForHer: string;
  costUsd: number; stages: Record<string, string>; error: string | null;
  editsPending: Edit[]; editsApplied: string[]; editsRefused: string | null;
};
type Board = {
  now: number;
  gpu: { making?: string; forStory?: string; pid?: number; since?: number } | null;
  watchdogMinutesAgo: number | null;
  totals: {
    stories: number; finished: number; running: number; queued: number;
    failed: number; editsWaiting: number; spentUsd: number;
  };
  jobs: Job[];
  recentErrors: string[];
};

const REFRESH_MS = 10_000;

function ago(ms: number | null, now: number): string {
  if (!ms) return "";
  const mins = Math.round((now - ms) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hr ago`;
  return `${Math.round(hours / 24)} d ago`;
}

export default function Admin() {
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [showDone, setShowDone] = useState(true);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/story/admin", { cache: "no-store" });
      const payload = await response.json();
      if (payload.error) { setError(payload.error); return; }
      setBoard(payload as Board);
      setError(null);
    } catch (caught) {
      // The dashboard going dark is itself information: the website is down.
      setError(`Cannot reach the studio: ${(caught as Error).message}`);
    }
  }, []);

  useEffect(() => {
    void load();
    timer.current = setInterval(() => void load(), REFRESH_MS);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [load]);

  if (error && !board) {
    return <main className="ad"><h1>Kathalu jobs</h1><p className="ad-dead">{error}</p></main>;
  }
  if (!board) return <main className="ad"><h1>Kathalu jobs</h1><p>Loading…</p></main>;

  const { totals, jobs, now } = board;
  const busy = jobs.filter((j) => j.status === "running" || j.status === "queued");
  const attention = jobs.filter((j) => j.status === "failed" || j.status === "abandoned"
                                    || j.editsPending.length > 0 || j.editsRefused);
  const shown = showDone ? jobs : jobs.filter((j) => j.status !== "done");

  return (
    <main className="ad">
      <header className="ad-top">
        <h1>Kathalu jobs</h1>
        <span className="ad-live">refreshing every {REFRESH_MS / 1000}s</span>
      </header>

      {error && <p className="ad-dead">{error}</p>}

      <section className="ad-tiles">
        <Tile n={totals.stories} label="stories" />
        <Tile n={totals.finished} label="finished" tone="good" />
        <Tile n={totals.running} label="making now" tone={totals.running ? "busy" : undefined} />
        <Tile n={totals.queued} label="waiting for the GPU" tone={totals.queued ? "warn" : undefined} />
        <Tile n={totals.failed} label="failed" tone={totals.failed ? "bad" : undefined} />
        <Tile n={totals.editsWaiting} label="edits asked for" tone={totals.editsWaiting ? "warn" : undefined} />
        <Tile n={`$${totals.spentUsd.toFixed(2)}`} label="OpenAI, all time" />
      </section>

      <section className="ad-gpu">
        {board.gpu ? (
          <p><strong>GPU:</strong> {board.gpu.making} for <em>{board.gpu.forStory}</em>
            {" "}(pid {board.gpu.pid}, started {ago((board.gpu.since ?? 0) * 1000, now)})</p>
        ) : <p><strong>GPU:</strong> idle</p>}
        <p className={board.watchdogMinutesAgo !== null && board.watchdogMinutesAgo <= 15
          ? "ad-ok" : "ad-warn"}>
          <strong>Watchdog:</strong>{" "}
          {board.watchdogMinutesAgo === null
            ? "has never run — it is not keeping anything alive"
            : `last checked ${board.watchdogMinutesAgo} min ago`}
        </p>
      </section>

      {busy.length > 0 && (
        <section>
          <h2>Happening now</h2>
          {busy.map((j) => (
            <div key={j.name} className={`ad-now ad-${j.status}`}>
              <span className="ad-title">{j.title}</span>
              <span className="ad-detail">{j.detail}</span>
              {j.scenes > 0 && (
                <span className="ad-bar" aria-label={`${j.shotsDone} of ${j.scenes}`}>
                  <span style={{ width: `${Math.round(100 * j.shotsDone / j.scenes)}%` }} />
                </span>
              )}
            </div>
          ))}
        </section>
      )}

      {attention.length > 0 && (
        <section>
          <h2>Needs you</h2>
          {attention.map((j) => (
            <div key={j.name} className="ad-attn">
              <div className="ad-attn-head">
                <span className="ad-title">{j.title}</span>
                <span className={`ad-chip ad-${j.status.replace(/\s/g, "-")}`}>
                  {j.editsRefused ? "edit refused" : j.status}
                </span>
              </div>
              {j.editsRefused && (
                <div className="ad-refused">
                  <b>her change was refused:</b>
                  <pre className="ad-err">{j.editsRefused}</pre>
                </div>
              )}
              {j.error && !j.editsRefused && <pre className="ad-err">{j.error}</pre>}
              {j.editsPending.length > 0 && (
                <ul className="ad-edits">
                  {j.editsPending.map((e, i) => (
                    <li key={i}>
                      <b>scene {e.scene}</b> <span className="ad-kind">{e.kind}</span>
                      {" — "}{e.asked}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </section>
      )}

      <section>
        <div className="ad-h2row">
          <h2>All stories</h2>
          <label className="ad-toggle">
            <input type="checkbox" checked={showDone}
              onChange={(e) => setShowDone(e.target.checked)} />
            show finished
          </label>
        </div>
        <table className="ad-table">
          <thead>
            <tr>
              <th>story</th><th>status</th><th>scenes</th><th>lang</th>
              <th>read</th><th>cost</th><th>changed</th><th />
            </tr>
          </thead>
          <tbody>
            {shown.map((j) => (
              <Fragment key={j.name}>
                <tr className={`ad-row ad-r-${j.status.replace(/\s/g, "-")}`}>
                  <td className="ad-cell-title">
                    <span className="ad-title">{j.title}</span>
                    {j.englishTitle && <span className="ad-sub">{j.englishTitle}</span>}
                  </td>
                  <td><span className={`ad-chip ad-${j.status.replace(/\s/g, "-")}`}>{j.status}</span>
                    <span className="ad-sub">{j.detail.slice(0, 60)}</span></td>
                  <td className="ad-num">
                    {j.scenes ? `${j.shotsDone}/${j.scenes}` : "—"}
                    {j.scenesOverCap && <span className="ad-over"> over cap</span>}
                  </td>
                  <td>{j.language || "—"}</td>
                  <td className="ad-num">
                    {j.recovered !== null ? `${Math.round(j.recovered * 100)}%` : "—"}
                  </td>
                  <td className="ad-num">{j.costUsd ? `$${j.costUsd.toFixed(2)}` : "—"}</td>
                  <td className="ad-num">{ago(j.updatedAt, now)}</td>
                  <td>
                    <button className="ad-more"
                      onClick={() => setOpen(open === j.name ? null : j.name)}>
                      {open === j.name ? "less" : "more"}
                    </button>
                  </td>
                </tr>
                {open === j.name && (
                  <tr className="ad-detailrow">
                    <td colSpan={8}>
                      <dl className="ad-dl">
                        <dt>folder</dt><dd><code>{j.name}</code></dd>
                        <dt>pages / aspect</dt><dd>{j.pages} page(s){j.aspect ? ` · ${j.aspect}` : ""}
                          {j.columns ? ` · ${j.columns} column(s)` : ""}</dd>
                        <dt>reading</dt><dd>
                          {j.readSeconds !== null ? `${j.readSeconds}s` : "—"}
                          {j.recovered !== null && ` · ${Math.round(j.recovered * 100)}% recovered`}
                          {j.photoComplete === false && " · photo incomplete"}
                          {j.filledSpans > 0 && ` · ${j.filledSpans} span(s) filled in`}
                        </dd>
                        {j.noteForHer && <><dt>told her</dt><dd>{j.noteForHer}</dd></>}
                        <dt>stages</dt><dd>{Object.keys(j.stages).length
                          ? Object.entries(j.stages).map(([k, v]) => `${k}:${v}`).join("  ")
                          : "—"}</dd>
                        <dt>audio / shots</dt><dd>{j.audioDone} wav · {j.shotsDone} mp4</dd>
                        {j.finishedAt && <><dt>finished</dt>
                          <dd>{ago(j.finishedAt, now)}{j.sizeMb ? ` · ${j.sizeMb} MB` : ""}</dd></>}
                        {j.editsApplied.length > 0 && (
                          <><dt>changes made</dt><dd>
                            <ul className="ad-applied">
                              {j.editsApplied.map((a, i) => <li key={i}>{a}</li>)}
                            </ul>
                          </dd></>
                        )}
                      </dl>
                      <div className="ad-links">
                        {j.finishedAt && (
                          <a href={`/api/story/file?dir=${encodeURIComponent(
                            `H:/KathaluStudio/stories/${j.name}`)}&rel=final.mp4`}
                            target="_blank" rel="noreferrer">watch the film</a>
                        )}
                        {j.scenes > 0 && <a href="/story">open in the studio</a>}
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </section>

      {board.recentErrors.length > 0 && (
        <section>
          <h2>Recent errors</h2>
          <pre className="ad-log">{board.recentErrors.join("\n")}</pre>
        </section>
      )}
    </main>
  );
}

function Tile({ n, label, tone }: { n: number | string; label: string; tone?: string }) {
  return (
    <div className={`ad-tile${tone ? ` ad-t-${tone}` : ""}`}>
      <span className="ad-tile-n">{n}</span>
      <span className="ad-tile-l">{label}</span>
    </div>
  );
}
