"use client";

/**
 * Rangulu, list mode -- paste a list of painting ideas, walk away, come back to videos.
 *
 * The sibling of /garden1, and written for the same reader: an operator's console, English,
 * one row per idea, the real error text on a failure, and the bill stated before the button
 * is pressed. The approval screen is deliberately absent, for the same reason it is absent on
 * /garden1 -- a list written in advance is judged afterwards, and the point is not to have to
 * be present.
 *
 * One addition. A gardening list has to come from the person who knows the tips; a painting
 * list can be invented, and inventing twenty ideas by hand is exactly the chore that stops a
 * list being made. "Suggest ideas" asks the model (`/api/paint/idea`) for ideas that are new
 * here -- it is shown every painting already made or queued, plus whatever is already in the
 * box -- and drops them into the box to be edited, deleted or added to before anything is
 * spent on them. If the model cannot be reached, the built-in lists answer and the page says so.
 *
 * The page owns nothing. It starts a detached driver and then polls the filesystem, so
 * closing it, reloading it, or opening it on a phone an hour later all show the same list in
 * the same state. The driver, the lock and the graphics card are shared with the gardening
 * lists: one list at a time, whichever kind it is.
 */

import { useCallback, useEffect, useState } from "react";

import { suggestIdeas as localIdeas } from "@/lib/paint-ideas";

type ItemStatus = "pending" | "planning" | "rendering" | "done" | "failed";

type BatchItem = {
  n: number;
  idea: string;
  slug: string;
  status: ItemStatus;
  titleTe: string;
  titleEn: string;
  understood: string;
  error: string | null;
};

type Batch = {
  id: string;
  createdAt: number;
  status: "running" | "done" | "failed" | "stopped";
  live: boolean;
  counts: { done: number; failed: number; pending: number; total: number };
  minutesLeft: number | null;
  current: { n: number; label: string; shotsDone: number; shotsTotal: number } | null;
  items: BatchItem[];
};

const MAX_IDEAS = 25;
const MINUTES_PER_REEL = 25;
const SUGGEST_COUNT = 10;
const OFFLINE_NOTE = "The idea model could not be reached, so these are from the built-in list.";

/** Blank lines and `#` comments are dropped server-side; count the same way here. */
function ideaLines(text: string): string[] {
  return text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
}

function estimate(count: number): string {
  const minutes = count * MINUTES_PER_REEL;
  if (minutes < 90) return `about ${minutes} minutes`;
  const hours = Math.round((minutes / 60) * 10) / 10;
  return `about ${hours} hours`;
}

const ACCENT = "#8a2f4a";

const STATUS_STYLE: Record<ItemStatus, React.CSSProperties> = {
  pending: { background: "#eae5d9", color: "#6b6257" },
  planning: { background: "#e4ecf6", color: "#2f4e75" },
  rendering: { background: "#f3e4e9", color: ACCENT },
  done: { background: ACCENT, color: "#fff" },
  failed: { background: "#fdeceb", color: "#8f403a" },
};

const STATUS_TEXT: Record<ItemStatus, string> = {
  pending: "waiting", planning: "writing", rendering: "making",
  done: "ready", failed: "failed",
};

export default function PaintBatch() {
  const [ideas, setIdeas] = useState("");
  const [batch, setBatch] = useState<Batch | null>(null);
  const [history, setHistory] = useState<Batch[]>([]);
  const [busy, setBusy] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [playing, setPlaying] = useState<string | null>(null);

  const count = ideaLines(ideas).length;
  // Across every list, deduplicated by slug exactly as the server gathers them -- an item
  // already pulled into a retry list appears on both lists, and must be counted once.
  const unfinished = new Set(
    history.flatMap((b) => b.items.filter((i) => i.status !== "done").map((i) => i.slug)),
  ).size;

  const loadList = useCallback(async () => {
    try {
      const got = await fetch("/api/paint1/batch", { cache: "no-store" });
      const data = await got.json() as { batches?: Batch[] };
      const all = data.batches ?? [];
      setHistory(all);
      // Reopening the page mid-run should land straight on the running list rather than on
      // an empty box -- that is the state it will most often be opened in.
      setBatch((shown) => shown ?? all.find((b) => b.live) ?? null);
    } catch { /* a dropped fetch is not worth a banner; the next visit lands */ }
  }, []);

  // The load is deferred behind a flag rather than called straight from the effect body, so
  // that Strict Mode's mount-unmount-mount does not fire two identical requests, and so the
  // state it sets lands from a callback rather than from the effect itself.
  useEffect(() => {
    let live = true;
    void (async () => { if (live) await loadList(); })();
    return () => { live = false; };
  }, [loadList]);

  /**
   * Poll while a list is running, and only while one is: the effect keys off `batch.live`,
   * so it starts itself when a list starts and tears itself down when the last video lands.
   *
   * Every 5s. A shot takes minutes, and the machine at the other end is busy with a graphics
   * card job, so anything faster is load for no new information.
   */
  useEffect(() => {
    if (!batch?.live) return;
    const id = batch.id;
    const timer = setInterval(async () => {
      try {
        const got = await fetch(`/api/paint1/batch?id=${encodeURIComponent(id)}`,
          { cache: "no-store" });
        const data = await got.json() as { batch?: Batch };
        if (data.batch) setBatch(data.batch);
      } catch { /* keep polling; a single dropped request means nothing */ }
    }, 5000);
    return () => clearInterval(timer);
  }, [batch?.live, batch?.id]);

  async function start() {
    setBusy(true); setProblem(null); setSkipped([]);
    try {
      const got = await fetch("/api/paint1/batch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ideas }),
      });
      const data = await got.json();
      if (!got.ok) throw new Error(data.error ?? "Could not start the list.");
      setSkipped(data.skipped ?? []);
      setBatch(data.batch as Batch);
      setIdeas("");
    } catch (caught) {
      setProblem(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function control(action: "stop" | "resume") {
    if (!batch) return;
    setBusy(true); setProblem(null);
    try {
      const got = await fetch("/api/paint1/control", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: batch.id, action }),
      });
      const data = await got.json();
      if (!got.ok) throw new Error(data.error ?? "That did not work.");
      setBatch(data.batch as Batch);
    } catch (caught) {
      setProblem(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  /** Retry every unfinished item across every painting list, gathered into one new list. */
  async function retryAll() {
    setBusy(true); setProblem(null); setSkipped([]);
    try {
      const got = await fetch("/api/paint1/control", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "retry-all" }),
      });
      const data = await got.json();
      if (!got.ok) throw new Error(data.error ?? "Could not start the retries.");
      // Anything past the per-list cap is named rather than dropped in silence.
      if (data.skipped?.length) {
        setSkipped(data.skipped.map(
          (s: string) => `Over the limit, not retried: "${s.slice(0, 60)}"`));
      }
      setBatch(data.batch as Batch);
      setPlaying(null);
    } catch (caught) {
      setProblem(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  /** Read a .txt straight into the box, since a list of twenty is usually already a file. */
  function loadFile(file: File | undefined) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setIdeas(String(reader.result ?? "").trim());
    reader.readAsText(file, "utf-8");     // UTF-8 explicitly: these lines are often Telugu
  }

  /** Under whatever is already in the box. A half-typed list must not vanish for a button. */
  function append(lines: string[]) {
    const block = lines.join("\n");
    setIdeas((have) => (have.trim() ? `${have.replace(/\s+$/, "")}\n${block}` : block));
  }

  /**
   * Ask the model for a handful of ideas nobody here has made. The server knows every reel
   * and list on disk; what only this page knows is what is already in the box, so those lines
   * go along as things to avoid. The built-in lists are the last resort, and are named as such.
   */
  async function suggest() {
    setThinking(true); setProblem(null);
    try {
      const got = await fetch("/api/paint/idea", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ count: SUGGEST_COUNT, avoid: ideaLines(ideas) }),
      });
      const data = await got.json() as { ideas?: string[]; source?: string; detail?: string };
      const lines = data.ideas ?? [];
      if (!got.ok || !lines.length) throw new Error(data.detail ?? "No ideas came back.");
      append(lines);
      if (data.source === "local") setProblem(OFFLINE_NOTE);
    } catch {
      append(localIdeas(SUGGEST_COUNT));
      setProblem(OFFLINE_NOTE);
    } finally {
      setThinking(false);
    }
  }

  function Row({ item }: { item: BatchItem }) {
    const isCurrent = batch?.current?.n === item.n;
    const open = playing === item.slug;
    return (
      <li style={S.row}>
        <div style={S.rowHead}>
          <span style={S.rowNum}>{item.n}</span>
          <div style={S.rowBody}>
            <div style={S.rowTitle}>{item.titleTe || item.titleEn || item.idea}</div>
            {/* The typed line stays visible next to the title the model chose: reading the
                two together is the only way to tell whether it understood the idea. */}
            {(item.titleTe || item.titleEn) && <div style={S.rowIdea}>{item.idea}</div>}
            {item.understood && <div style={S.rowIdea}>{item.understood}</div>}
            {isCurrent && batch?.current && item.status !== "done" && (
              <div style={S.rowStage}>
                {batch.current.label}
                <div style={S.track}>
                  <div style={{
                    ...S.fill,
                    width: `${Math.round((batch.current.shotsDone
                      / Math.max(1, batch.current.shotsTotal)) * 100)}%`,
                  }} />
                </div>
              </div>
            )}
            {item.error && <div style={S.rowError}>{item.error}</div>}
          </div>
          <span style={{ ...S.pill, ...STATUS_STYLE[item.status] }}>
            {STATUS_TEXT[item.status]}
          </span>
        </div>

        {item.status === "done" && (
          open ? (
            <video
              style={S.video}
              controls
              autoPlay
              playsInline
              src={`/api/paint/file?slug=${encodeURIComponent(item.slug)}&rel=${
                encodeURIComponent(`${item.slug}_te.mp4`)}`}
            />
          ) : (
            <button style={S.watch} onClick={() => setPlaying(item.slug)}>Watch</button>
          )
        )}
      </li>
    );
  }

  return (
    <main style={S.page}>
      <header style={S.header}>
        <div>
          <div style={S.brand}>Rangulu &mdash; list</div>
          <div style={S.tagline}>
            Paste painting ideas, one per line. A subject, a medium, a mood &mdash; the model
            chooses the rest. They are made one after another, no approving.
          </div>
        </div>
        <div style={S.links}>
          <a href="/paint" style={S.link}>one at a time &rarr;</a>
          <a href="/garden1" style={S.link}>gardening lists &rarr;</a>
        </div>
      </header>

      {problem && (
        <div style={S.problem}>
          <strong>Something went wrong</strong>
          <div style={S.problemText}>{problem}</div>
        </div>
      )}

      {skipped.length > 0 && (
        <div style={S.note}>
          <strong>Lines left out</strong>
          <ul style={S.noteList}>
            {skipped.map((s, i) => <li key={i}>{s}</li>)}
          </ul>
        </div>
      )}

      {/* Always rendered, never hidden behind a running list. Hiding it meant that opening
          the page while something was already being made showed no box at all, which reads
          as a broken page rather than as a busy one. */}
      <section style={{ ...S.card, order: batch?.live ? 2 : 1 }}>
        <h1 style={S.h1}>Your ideas</h1>
        <p style={S.help}>
          One idea per line &mdash; a word is enough. Telugu, Telugu in English letters, or
          English. Blank lines and lines starting with # are ignored. Up to {MAX_IDEAS} at a
          time; each takes about {MINUTES_PER_REEL} minutes of graphics card.
        </p>
        <textarea
          style={S.textarea}
          value={ideas}
          onChange={(e) => setIdeas(e.target.value)}
          placeholder={"a kingfisher on a bent reed, in soft pastels\n"
            + "varsham lo palleturu, water colour lo\n"
            + "Warli figures on an ochre mud wall, white rice paste"}
          rows={9}
          spellCheck={false}
        />
        <div style={S.tools}>
          <div style={S.toolGroup}>
            <button
              style={{ ...S.tool, ...(busy || thinking ? S.disabled : {}) }}
              onClick={() => void suggest()}
              disabled={busy || thinking}
            >
              {thinking ? "Thinking..." : `Suggest ${SUGGEST_COUNT} ideas`}
            </button>
            <label style={S.tool}>
              Upload a .txt
              <input
                type="file"
                accept=".txt,text/plain"
                style={{ display: "none" }}
                onChange={(e) => loadFile(e.target.files?.[0])}
              />
            </label>
          </div>
          <span style={S.counter}>
            {count === 0 ? "no ideas yet"
              : `${count} idea${count === 1 ? "" : "s"} · ${estimate(count)}`}
            {count > MAX_IDEAS && ` · too many, ${MAX_IDEAS} is the most`}
          </span>
        </div>
        <button
          style={{ ...S.primary,
            ...(busy || thinking || count === 0 || count > MAX_IDEAS || batch?.live ? S.disabled : {}) }}
          disabled={busy || thinking || count === 0 || count > MAX_IDEAS || Boolean(batch?.live)}
          onClick={() => void start()}
        >
          {busy ? "Starting..."
            : batch?.live ? "A list is being made below"
            : `Make ${count || ""} video${count === 1 ? "" : "s"}`}
        </button>
        {batch?.live && (
          <p style={{ ...S.help, margin: "10px 0 0" }}>
            Write the next list here while this one runs. It can start as soon as the list
            below finishes, or press Stop on it.
          </p>
        )}
      </section>

      {batch && (
        <section style={{ ...S.card, order: batch.live ? 1 : 2 }}>
          <div style={S.statusHead}>
            <h2 style={S.h2}>
              {batch.live ? "Making your videos"
                : batch.status === "done" ? "List finished"
                : "List stopped"}
            </h2>
            {batch.live ? (
              <button style={S.stop} disabled={busy} onClick={() => void control("stop")}>
                Stop
              </button>
            ) : (batch.counts.done + batch.counts.failed) < batch.counts.total
                || batch.counts.failed > 0 ? (
              // One button for two situations that are the same underneath: carrying on
              // after an interruption, and retrying the ones that failed.
              <button style={S.resume} disabled={busy} onClick={() => void control("resume")}>
                {batch.counts.pending > 0 ? "Carry on" : "Try the failed ones again"}
              </button>
            ) : null}
          </div>

          <div style={S.summary}>
            {batch.counts.done} of {batch.counts.total} ready
            {batch.counts.failed > 0 && ` · ${batch.counts.failed} failed`}
            {batch.live && batch.minutesLeft !== null
              && ` · about ${batch.minutesLeft} minutes left`}
          </div>
          {batch.live && (
            <p style={S.help}>
              You can close this page. It carries on without it, and this list will be here
              when you come back.
            </p>
          )}

          <ul style={S.rows}>
            {batch.items.map((item) => <Row key={item.slug} item={item} />)}
          </ul>
        </section>
      )}

      {history.length > 0 && (
        <section style={S.shelf}>
          <div style={S.shelfHead}>
            <h2 style={S.h2}>Earlier lists</h2>
            {!batch?.live && unfinished > 0 && (
              <button style={S.resume} disabled={busy} onClick={() => void retryAll()}>
                {busy ? "Starting..." : `Try all ${unfinished} unfinished again`}
              </button>
            )}
          </div>
          {history.filter((b) => b.id !== batch?.id).map((b) => (
            <button key={b.id} style={S.histRow} onClick={() => { setBatch(b); setPlaying(null); }}>
              <span>{new Date(b.createdAt).toLocaleString()}</span>
              <span style={S.histCount}>
                {b.counts.done}/{b.counts.total} ready
                {b.counts.failed > 0 && `, ${b.counts.failed} failed`}
              </span>
            </button>
          ))}
        </section>
      )}
    </main>
  );
}

/* Inline styles, matching /garden1 -- same bones, madder red instead of leaf green so the two
   consoles are never mistaken for each other. Denser than /paint on purpose: this page shows
   twenty-five rows at once and is read at a desk, not outdoors. */
const S: Record<string, React.CSSProperties> = {
  page: {
    minHeight: "100vh", background: "#f6f1ea", color: "#241f1a",
    fontFamily: "system-ui, 'Noto Sans Telugu', sans-serif",
    padding: "20px 16px 64px", maxWidth: 760, margin: "0 auto",
    // Flex only so the two cards can swap places: a running list belongs above the box,
    // an idle page belongs box-first. Header and banners stay at the default order 0.
    display: "flex", flexDirection: "column",
  },
  header: {
    display: "flex", justifyContent: "space-between", alignItems: "flex-start",
    gap: 12, marginBottom: 22,
  },
  brand: { fontSize: 28, fontWeight: 700, color: ACCENT, lineHeight: 1.2 },
  tagline: { fontSize: 15, color: "#6b6257", marginTop: 4, maxWidth: 460 },
  links: { display: "flex", flexDirection: "column", gap: 6, flexShrink: 0, paddingTop: 6 },
  link: { fontSize: 14, color: "#57503f" },
  card: {
    background: "#fff", borderRadius: 18, padding: "22px 20px", marginBottom: 18,
    boxShadow: "0 2px 14px rgba(60,50,35,0.08)",
  },
  h1: { fontSize: 22, fontWeight: 700, margin: "0 0 8px", lineHeight: 1.35 },
  h2: { fontSize: 19, fontWeight: 700, margin: 0, color: "#3b352c" },
  help: { fontSize: 14.5, color: "#6b6257", margin: "0 0 14px", lineHeight: 1.6 },
  textarea: {
    width: "100%", boxSizing: "border-box", fontSize: 16, lineHeight: 1.75,
    padding: 14, borderRadius: 12, border: "1.5px solid #d8d2c6",
    fontFamily: "inherit", resize: "vertical", background: "#fdfcfa",
  },
  tools: {
    display: "flex", justifyContent: "space-between", alignItems: "center",
    gap: 12, marginTop: 10, flexWrap: "wrap",
  },
  toolGroup: { display: "flex", gap: 8, flexWrap: "wrap" },
  tool: {
    fontSize: 14, color: ACCENT, cursor: "pointer", background: "none",
    border: "1.5px solid #c8c0b2", borderRadius: 999, padding: "7px 14px",
    fontFamily: "inherit",
  },
  counter: { fontSize: 14, color: "#6b6257" },
  primary: {
    width: "100%", marginTop: 16, padding: "15px 20px", fontSize: 18, fontWeight: 600,
    color: "#fff", background: ACCENT, border: "none", borderRadius: 12,
    cursor: "pointer", fontFamily: "inherit",
  },
  disabled: { opacity: 0.45, cursor: "default" },
  statusHead: {
    display: "flex", justifyContent: "space-between", alignItems: "center",
    gap: 12, marginBottom: 6,
  },
  stop: {
    background: "none", border: "1.5px solid #d9b2ae", borderRadius: 999,
    padding: "7px 16px", fontSize: 14, color: "#8f403a", cursor: "pointer",
    fontFamily: "inherit", flexShrink: 0,
  },
  resume: {
    background: "none", border: "1.5px solid #cfa9b6", borderRadius: 999,
    padding: "7px 16px", fontSize: 14, color: ACCENT, cursor: "pointer",
    fontFamily: "inherit", flexShrink: 0,
  },
  summary: { fontSize: 15, color: "#4a443a", margin: "0 0 12px" },
  rows: { listStyle: "none", margin: 0, padding: 0 },
  row: { borderTop: "1px solid #ece7dc", padding: "13px 0" },
  rowHead: { display: "flex", gap: 11, alignItems: "flex-start" },
  rowNum: {
    fontSize: 13, color: "#a09788", minWidth: 18, paddingTop: 3, flexShrink: 0,
    fontVariantNumeric: "tabular-nums",
  },
  rowBody: { flex: 1, minWidth: 0 },
  rowTitle: { fontSize: 16.5, lineHeight: 1.5, color: "#2f2a22", fontWeight: 600 },
  rowIdea: { fontSize: 13.5, lineHeight: 1.55, color: "#8d8577", marginTop: 3 },
  rowStage: { fontSize: 13.5, color: ACCENT, marginTop: 7 },
  rowError: {
    fontSize: 13, color: "#8f403a", marginTop: 7, whiteSpace: "pre-wrap",
    wordBreak: "break-word", background: "#fdf3f2", borderRadius: 8, padding: "8px 10px",
  },
  pill: {
    fontSize: 12, fontWeight: 600, borderRadius: 999, padding: "4px 11px",
    flexShrink: 0, letterSpacing: 0.2,
  },
  track: {
    height: 7, background: "#ebe4da", borderRadius: 999, overflow: "hidden",
    margin: "6px 0 0", maxWidth: 320,
  },
  fill: { height: "100%", background: ACCENT, transition: "width 400ms ease" },
  watch: {
    marginTop: 9, marginLeft: 29, background: "none", border: "1.5px solid #c8c0b2",
    borderRadius: 999, padding: "6px 15px", fontSize: 13.5, color: ACCENT,
    cursor: "pointer", fontFamily: "inherit",
  },
  video: {
    width: "100%", maxWidth: 260, borderRadius: 12, background: "#000",
    marginTop: 10, marginLeft: 29, aspectRatio: "9 / 16", objectFit: "contain",
  },
  shelf: { marginTop: 8, order: 3 },
  shelfHead: {
    display: "flex", justifyContent: "space-between", alignItems: "center",
    gap: 12, marginBottom: 4, flexWrap: "wrap",
  },
  histRow: {
    display: "flex", justifyContent: "space-between", gap: 12, width: "100%",
    background: "#fff", border: "none", borderRadius: 12, padding: "13px 16px",
    marginTop: 8, fontSize: 14.5, color: "#4a443a", cursor: "pointer",
    fontFamily: "inherit", textAlign: "left",
    boxShadow: "0 1px 8px rgba(60,50,35,0.06)",
  },
  histCount: { color: "#8d8577", flexShrink: 0 },
  problem: {
    background: "#fdeceb", border: "1.5px solid #e8b7b3", borderRadius: 12,
    padding: "14px 16px", marginBottom: 18, fontSize: 15, lineHeight: 1.6,
  },
  problemText: { marginTop: 6, color: "#7a3b36", wordBreak: "break-word" },
  note: {
    background: "#fdf7e8", border: "1.5px solid #e6d8ac", borderRadius: 12,
    padding: "14px 16px", marginBottom: 18, fontSize: 14.5, lineHeight: 1.6,
  },
  noteList: { margin: "6px 0 0", paddingLeft: 20, color: "#6b5c33" },
};
