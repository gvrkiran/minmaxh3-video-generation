"use client";

/**
 * Tota -- type one gardening tip, get a little video.
 *
 * Four screens, strictly linear, one decision on each. The person using this grows
 * vegetables on a terrace; she is not a technologist and will very likely be on a phone.
 * So: no seed, no model name, no megapixels, no aspect ratio, no percentages. Waiting is
 * always described in minutes.
 *
 * Telugu is the DEFAULT here, unlike /story which opens in English. The audience for this
 * page is one person and she reads Telugu; English is the toggle, not the other way round.
 *
 * She may type Telugu script or Telugu spelled in English letters ("bellam neellu
 * vaaraaniki oka sari") -- that is how she actually types, so the box says so out loud and
 * the model is told to expect it.
 *
 * The plan screen exists for one reason: a video costs about twenty minutes of graphics
 * card, and letting her see the three lines first turns a twenty-minute mistake into a
 * five-second one.
 */

import { useCallback, useEffect, useRef, useState } from "react";

type Screen = "type" | "plan" | "making" | "done" | "watch";

type Plan = {
  slug: string;
  titleTe: string;
  titleEn: string;
  understood: string;
  narrationTe: string[];
};

type LibraryItem = {
  slug: string;
  titleTe: string;
  titleEn: string;
  seconds: number | null;
  languages: Array<"te" | "en">;
  source: "made" | "library";
  madeAt: number | null;
  poster: boolean;
};

type MakingItem = {
  slug: string;
  titleTe: string;
  titleEn: string;
  stage: "queued" | "narrating" | "rendering" | "assembling" | "failed";
  shotsDone: number;
  shotsTotal: number;
  minutesLeft: number | null;
  startedAt: number | null;
};

type Progress = {
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

const COPY = {
  te: {
    brand: "తోట",
    tagline: "ఒక చిట్కా చెప్పండి, చిన్న వీడియో తయారవుతుంది",
    prompt: "మీ తోట చిట్కా ఏమిటి?",
    help: "తెలుగులో రాయండి, లేదా ఇంగ్లీషు అక్షరాలతో తెలుగు రాసినా సరిపోతుంది.",
    placeholder:
      "ఉదా: మొక్కలు బాగా ఎదగాలంటే నెలకి ఒకసారి మొక్క చుట్టూ తవ్వాలి, వారానికి ఒకసారి బెల్లం నీళ్ళు పోయాలి",
    write: "ముందుకు సాగండి",
    writing: "మీ చిట్కాను చదువుతున్నాను...",
    planTitle: "ఇలా చేద్దామా?",
    understood: "నేను అర్థం చేసుకున్నది",
    willSay: "వీడియోలో ఇలా చెబుతుంది",
    make: "వీడియో తయారు చేయండి",
    again: "వద్దు, మళ్ళీ రాస్తాను",
    makingTitle: "వీడియో తయారవుతోంది",
    minutes: "నిమిషాలు",
    closeOk: "మీరు ఈ పేజీ మూసేసినా పర్వాలేదు. తయారయ్యాక ఇక్కడే ఉంటుంది.",
    doneTitle: "మీ వీడియో సిద్ధం",
    makeAnother: "ఇంకొకటి చేయండి",
    problem: "ఏదో తేడా వచ్చింది",
    retry: "మళ్ళీ ప్రయత్నించండి",
    inEnglish: "English",
    library: "అన్ని వీడియోలు",
    mine: "నేను చేసినవి",
    ready: "సిద్ధంగా ఉన్నవి",
    empty: "ఇంకా వీడియోలు లేవు.",
    seconds: "సెకన్లు",
    back: "వెనక్కి",
    newVideo: "కొత్త వీడియో",
    surprise: "ఏదో ఒకటి సూచించండి",
    surprising: "ఆలోచిస్తున్నాను...",
    orType: "లేదా",
    making: "ఇప్పుడు తయారవుతున్నవి",
    stageQueued: "వంతు కోసం ఎదురుచూస్తోంది",
    stageVoice: "గొంతు రికార్డ్ అవుతోంది",
    stageAssembling: "కలిపి పెడుతోంది",
    stageFailed: "ఏదో తేడా వచ్చింది",
    picture: (a: number, b: number) => `${a} / ${b} బొమ్మ తయారవుతోంది`,
    left: (m: number) => `సుమారు ${m} నిమిషాలు`,
  },
  en: {
    brand: "Tota",
    tagline: "Tell it one tip, get a little video",
    prompt: "What is your gardening tip?",
    help: "Write in Telugu, or in Telugu spelled with English letters. Either is fine.",
    placeholder:
      "e.g. once a month dig around the plant, and once a week pour jaggery water",
    write: "Carry on",
    writing: "Reading your tip...",
    planTitle: "Shall we do this?",
    understood: "What I understood",
    willSay: "The video will say",
    make: "Make the video",
    again: "No, let me write it again",
    makingTitle: "Making your video",
    minutes: "minutes",
    closeOk: "You can close this page. It will be here when it is ready.",
    doneTitle: "Your video is ready",
    makeAnother: "Make another one",
    problem: "Something went wrong",
    retry: "Try again",
    inEnglish: "తెలుగు",
    library: "All videos",
    mine: "Made here",
    ready: "Ready to watch",
    empty: "No videos yet.",
    seconds: "seconds",
    back: "Back",
    newVideo: "New video",
    surprise: "Surprise me",
    surprising: "Thinking...",
    orType: "or",
    making: "Being made now",
    stageQueued: "Waiting its turn",
    stageVoice: "Recording the voice",
    stageAssembling: "Putting it together",
    stageFailed: "Something went wrong",
    picture: (a: number, b: number) => `Making picture ${a} of ${b}`,
    left: (m: number) => `about ${m} minutes`,
  },
};

export default function Garden() {
  const [lang, setLang] = useState<"te" | "en">("te");
  const [screen, setScreen] = useState<Screen>("type");
  const [tip, setTip] = useState("");
  const [busy, setBusy] = useState(false);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [library, setLibrary] = useState<LibraryItem[]>([]);
  const [watching, setWatching] = useState<LibraryItem | null>(null);
  const [making, setMaking] = useState<MakingItem[]>([]);
  // Separate from `busy` so the two buttons under the box do not grey each other out: asking
  // for an idea and sending one off to be planned are different waits.
  const [thinking, setThinking] = useState(false);
  // Every idea offered this sitting, so pressing the button twice cannot offer the same one.
  // Only the page knows these -- the module reads what is on disk, and none of these are.
  const [offered, setOffered] = useState<string[]>([]);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);

  const t = COPY[lang];

  const loadLibrary = useCallback(async () => {
    try {
      const got = await fetch("/api/garden/library", { cache: "no-store" });
      const data = await got.json() as { items?: LibraryItem[] };
      setLibrary(data.items ?? []);
    } catch { /* the shelf is not worth an error banner; the next visit will fill it */ }
  }, []);

  useEffect(() => { void loadLibrary(); }, [loadLibrary]);

  /**
   * What is being made, while the home screen is open.
   *
   * Every 8s, and only on the screens that show it. A shot takes minutes and the machine at
   * the other end is busy with a graphics-card job, so anything faster is load for no new
   * information. Deferred behind a flag rather than called straight from the effect body, so
   * Strict Mode's mount-unmount-mount does not fire two identical requests.
   */
  useEffect(() => {
    if (screen !== "type" && screen !== "done") return;
    let live = true;
    const tick = async () => {
      try {
        const got = await fetch("/api/garden/making", { cache: "no-store" });
        const data = await got.json() as { items?: MakingItem[] };
        if (live) setMaking(data.items ?? []);
      } catch { /* a dropped poll is not worth a banner; the next one lands */ }
    };
    void (async () => { if (live) await tick(); })();
    const timer = setInterval(tick, 8000);
    return () => { live = false; clearInterval(timer); };
  }, [screen]);

  const stopPolling = useCallback(() => {
    if (poll.current) { clearInterval(poll.current); poll.current = null; }
  }, []);

  // Poll while the render runs. Every 5s: a shot takes minutes, so anything faster is just
  // load on a machine that is busy with a graphics card job.
  const startPolling = useCallback((slug: string) => {
    stopPolling();
    const tick = async () => {
      try {
        const got = await fetch(`/api/garden/progress?slug=${encodeURIComponent(slug)}`,
          { cache: "no-store" });
        const next = await got.json() as Progress;
        setProgress(next);
        if (next.ready) {
          stopPolling();
          setScreen("done");
          void loadLibrary();      // it belongs on the shelf the moment it exists
        } else if (next.stage === "failed") {
          stopPolling();
          setProblem(next.failed ?? null);
        }
      } catch { /* a dropped poll is not worth showing her; the next one will land */ }
    };
    void tick();
    poll.current = setInterval(tick, 5000);
  }, [stopPolling, loadLibrary]);

  useEffect(() => stopPolling, [stopPolling]);

  async function writePlan() {
    setBusy(true);
    setProblem(null);
    try {
      const got = await fetch("/api/garden/plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tip }),
      });
      const data = await got.json();
      if (!got.ok) throw new Error(data.error ?? "Could not write the plan.");
      setPlan(data.plan as Plan);
      setScreen("plan");
    } catch (caught) {
      setProblem(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function makeVideo() {
    if (!plan) return;
    setBusy(true);
    setProblem(null);
    try {
      const got = await fetch("/api/garden/render", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug: plan.slug }),
      });
      const data = await got.json();
      if (!got.ok) throw new Error(data.error ?? "Could not start.");
      setProgress(data.progress as Progress);
      setScreen("making");
      startPolling(plan.slug);
    } catch (caught) {
      setProblem(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  /** Ask for an idea and put it in the box. She edits or replaces it from there. */
  async function surpriseMe() {
    setThinking(true);
    setProblem(null);
    try {
      const got = await fetch("/api/garden/idea", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // Whatever is in the box counts as taken too: pressing the button after typing half
        // an idea should not hand back the half already there.
        body: JSON.stringify({ lang, avoid: [...offered, tip].filter(Boolean) }),
      });
      const data = await got.json();
      if (!got.ok) throw new Error(data.error ?? "Could not think of one.");
      setTip(String(data.idea ?? ""));
      setOffered((was) => [...was, String(data.idea ?? "")].slice(-20));
    } catch (caught) {
      setProblem(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setThinking(false);
    }
  }

  /** What a reel being made is doing, in the language she is reading. */
  function stageWords(item: MakingItem): string {
    if (item.stage === "queued") return t.stageQueued;
    if (item.stage === "failed") return t.stageFailed;
    if (item.stage === "assembling") return t.stageAssembling;
    if (item.stage === "narrating") return t.stageVoice;
    return t.picture(Math.min(item.shotsDone + 1, item.shotsTotal), item.shotsTotal);
  }

  /** The reels on the way, above the shelf of finished ones. */
  function Making() {
    if (!making.length) return null;
    return (
      <section style={S.shelf}>
        <h2 style={S.h2}>{t.making}</h2>
        <ul style={S.makingList}>
          {making.map((item) => (
            <li key={item.slug} style={S.makingRow}>
              <div style={S.makingTitle}>
                {lang === "te" ? (item.titleTe || item.titleEn) : (item.titleEn || item.titleTe)}
              </div>
              <div style={item.stage === "failed" ? S.makingStageBad : S.makingStage}>
                {stageWords(item)}
                {item.stage !== "failed" && item.minutesLeft !== null
                  && ` \u00b7 ${t.left(item.minutesLeft)}`}
              </div>
              {item.stage !== "failed" && (
                <div style={S.track}>
                  <div style={{
                    ...S.fill,
                    width: `${Math.round((item.shotsDone
                      / Math.max(1, item.shotsTotal)) * 100)}%`,
                  }} />
                </div>
              )}
              {/* A reel that died is still shown, and shown as fixable. Dropping it from the
                  list would be the worse choice: it never reaches the shelf either, so it
                  would simply vanish, which is how a lost video goes unnoticed for a week.
                  The render resumes -- every finished shot is kept. */}
              {item.stage === "failed" && (
                <button style={S.makingRetry} onClick={() => void retryMaking(item.slug)}>
                  {t.retry}
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>
    );
  }

  /** Start a stalled reel again. It carries on from the last finished shot. */
  async function retryMaking(slug: string) {
    setProblem(null);
    try {
      const got = await fetch("/api/garden/render", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug }),
      });
      const data = await got.json();
      if (!got.ok) throw new Error(data.error ?? "Could not start it again.");
    } catch (caught) {
      setProblem(caught instanceof Error ? caught.message : String(caught));
    }
  }

  function startOver() {
    stopPolling();
    setPlan(null); setProgress(null); setProblem(null); setTip(""); setWatching(null);
    setScreen("type");
    void loadLibrary();
  }

  function watch(item: LibraryItem) {
    setWatching(item);
    setScreen("watch");
  }

  /** Cards for the shelf. Rendered under the typing box and on the watch screen. */
  function Shelf() {
    if (!library.length) return <p style={S.help}>{t.empty}</p>;
    const mine = library.filter((i) => i.source === "made");
    const rest = library.filter((i) => i.source === "library");
    return (
      <>
        {mine.length > 0 && (
          <>
            <div style={S.shelfLabel}>{t.mine}</div>
            <div style={S.grid}>{mine.map((i) => <Card key={i.slug} item={i} />)}</div>
          </>
        )}
        {rest.length > 0 && (
          <>
            <div style={S.shelfLabel}>{t.ready}</div>
            <div style={S.grid}>{rest.map((i) => <Card key={i.slug} item={i} />)}</div>
          </>
        )}
      </>
    );
  }

  function Card({ item }: { item: LibraryItem }) {
    const title = lang === "te" ? (item.titleTe || item.titleEn) : (item.titleEn || item.titleTe);
    return (
      <button style={S.card2} onClick={() => watch(item)}>
        <div style={S.thumbWrap}>
          {item.poster ? (
            <img
              style={S.thumb}
              alt=""
              loading="lazy"
              src={`/api/garden/file?slug=${encodeURIComponent(item.slug)}&rel=poster.jpg`}
            />
          ) : <div style={{ ...S.thumb, background: "#ddd7ca" }} />}
          {item.seconds !== null && (
            <span style={S.badge}>{Math.round(item.seconds)}s</span>
          )}
        </div>
        <div style={S.cardTitle}>{title}</div>
      </button>
    );
  }

  return (
    <main style={S.page}>
      <header style={S.header}>
        <div>
          <div style={S.brand}>{t.brand}</div>
          <div style={S.tagline}>{t.tagline}</div>
        </div>
        <button style={S.langButton} onClick={() => setLang(lang === "te" ? "en" : "te")}>
          {t.inEnglish}
        </button>
      </header>

      {problem && (
        <div style={S.problem}>
          <strong>{t.problem}</strong>
          <div style={S.problemText}>{problem}</div>
        </div>
      )}

      {screen === "type" && (
        <section style={S.card}>
          <h1 style={S.h1}>{t.prompt}</h1>
          <p style={S.help}>{t.help}</p>
          <textarea
            style={S.textarea}
            value={tip}
            onChange={(e) => setTip(e.target.value)}
            placeholder={t.placeholder}
            rows={5}
            autoFocus
          />
          <button
            style={{ ...S.primary, ...(busy || tip.trim().length < 10 ? S.disabled : {}) }}
            disabled={busy || tip.trim().length < 10}
            onClick={() => void writePlan()}
          >
            {busy ? t.writing : t.write}
          </button>
          {/* Under the main button, not beside it: this is the way out of a blank box, not a
              second thing to choose between. It only fills the box -- she still reads what it
              wrote, changes it if she likes, and presses Carry on herself. */}
          <button
            style={{ ...S.surprise, ...(thinking || busy ? S.disabled : {}) }}
            disabled={thinking || busy}
            onClick={() => void surpriseMe()}
          >
            {thinking ? t.surprising : t.surprise}
          </button>
        </section>
      )}

      {screen === "type" && <Making />}

      {screen === "type" && (
        <section style={S.shelf}>
          <h2 style={S.h2}>{t.library}</h2>
          <Shelf />
        </section>
      )}

      {screen === "watch" && watching && (
        <section style={S.card}>
          <button style={S.back} onClick={() => { setWatching(null); setScreen("type"); }}>
            &larr; {t.back}
          </button>
          <h1 style={S.h1}>
            {lang === "te" ? (watching.titleTe || watching.titleEn) : (watching.titleEn || watching.titleTe)}
          </h1>
          <video
            key={`${watching.slug}-${lang}`}
            style={S.video}
            controls
            autoPlay
            playsInline
            poster={watching.poster
              ? `/api/garden/file?slug=${encodeURIComponent(watching.slug)}&rel=poster.jpg`
              : undefined}
            src={`/api/garden/file?slug=${encodeURIComponent(watching.slug)}&rel=${encodeURIComponent(
              `${watching.slug}_${watching.languages.includes(lang) ? lang : "te"}.mp4`)}`}
          />
          <button style={S.primary} onClick={startOver}>{t.newVideo}</button>
        </section>
      )}

      {screen === "plan" && plan && (
        <section style={S.card}>
          <h1 style={S.h1}>{t.planTitle}</h1>
          <div style={S.planTitle}>{plan.titleTe}</div>

          <div style={S.label}>{t.understood}</div>
          <p style={S.understood}>{plan.understood}</p>

          <div style={S.label}>{t.willSay}</div>
          <ol style={S.lines}>
            {plan.narrationTe.map((line, i) => (
              <li key={i} style={S.line}>{line}</li>
            ))}
          </ol>

          <button
            style={{ ...S.primary, ...(busy ? S.disabled : {}) }}
            disabled={busy}
            onClick={() => void makeVideo()}
          >
            {t.make}
          </button>
          <button style={S.secondary} onClick={startOver}>{t.again}</button>
        </section>
      )}

      {screen === "making" && (
        <section style={S.card}>
          <h1 style={S.h1}>{t.makingTitle}</h1>
          {progress && (
            <>
              <div style={S.planTitle}>{progress.titleTe || plan?.titleTe}</div>
              <div style={S.stage}>{progress.label}</div>
              {progress.minutesLeft !== null && (
                <div style={S.minutes}>
                  {progress.minutesLeft} {t.minutes}
                </div>
              )}
              <div style={S.track}>
                <div style={{
                  ...S.fill,
                  width: `${Math.round((progress.shotsDone / Math.max(1, progress.shotsTotal)) * 100)}%`,
                }} />
              </div>
            </>
          )}
          <p style={S.help}>{t.closeOk}</p>
        </section>
      )}

      {screen === "done" && progress?.video && (
        <section style={S.card}>
          <h1 style={S.h1}>{t.doneTitle}</h1>
          <div style={S.planTitle}>{progress.titleTe}</div>
          <video
            style={S.video}
            controls
            playsInline
            src={`/api/garden/file?slug=${encodeURIComponent(progress.slug)}&rel=${encodeURIComponent(progress.video)}`}
          />
          <button style={S.primary} onClick={startOver}>{t.makeAnother}</button>
        </section>
      )}

      {screen === "done" && <Making />}

      {screen === "done" && (
        <section style={S.shelf}>
          <h2 style={S.h2}>{t.library}</h2>
          <Shelf />
        </section>
      )}
    </main>
  );
}

/* Inline styles, matching how /story is written -- this app ships no CSS framework, and a
   stylesheet for one page would be a second place to look. Sizes are deliberately large:
   she reads this on a phone, often outdoors. */
const S: Record<string, React.CSSProperties> = {
  page: {
    minHeight: "100vh", background: "#f4f1ea", color: "#241f1a",
    fontFamily: "system-ui, 'Noto Sans Telugu', sans-serif",
    padding: "20px 16px 64px", maxWidth: 680, margin: "0 auto",
  },
  header: {
    display: "flex", justifyContent: "space-between", alignItems: "flex-start",
    gap: 12, marginBottom: 24,
  },
  brand: { fontSize: 30, fontWeight: 700, color: "#2f5d3a", lineHeight: 1.2 },
  tagline: { fontSize: 15, color: "#6b6257", marginTop: 4 },
  langButton: {
    background: "none", border: "1.5px solid #c8c0b2", borderRadius: 999,
    padding: "8px 16px", fontSize: 15, color: "#57503f", cursor: "pointer",
    flexShrink: 0, fontFamily: "inherit",
  },
  card: {
    background: "#fff", borderRadius: 18, padding: "24px 20px",
    boxShadow: "0 2px 14px rgba(60,50,35,0.08)",
  },
  h1: { fontSize: 23, fontWeight: 700, margin: "0 0 8px", lineHeight: 1.35 },
  help: { fontSize: 15, color: "#6b6257", margin: "0 0 16px", lineHeight: 1.6 },
  textarea: {
    width: "100%", boxSizing: "border-box", fontSize: 18, lineHeight: 1.7,
    padding: 14, borderRadius: 12, border: "1.5px solid #d8d2c6",
    fontFamily: "inherit", resize: "vertical", background: "#fdfcfa",
  },
  primary: {
    width: "100%", marginTop: 18, padding: "16px 20px", fontSize: 19, fontWeight: 600,
    color: "#fff", background: "#2f5d3a", border: "none", borderRadius: 12,
    cursor: "pointer", fontFamily: "inherit",
  },
  secondary: {
    width: "100%", marginTop: 10, padding: "13px 20px", fontSize: 16,
    color: "#6b6257", background: "none", border: "none", cursor: "pointer",
    fontFamily: "inherit", textDecoration: "underline",
  },
  disabled: { opacity: 0.45, cursor: "default" },
  planTitle: { fontSize: 21, fontWeight: 700, color: "#2f5d3a", margin: "4px 0 18px" },
  label: {
    fontSize: 13, textTransform: "uppercase", letterSpacing: 0.7,
    color: "#8d8577", marginTop: 16, marginBottom: 6,
  },
  understood: { fontSize: 16, lineHeight: 1.6, margin: 0, color: "#4a443a" },
  lines: { margin: "0", paddingLeft: 22 },
  line: { fontSize: 18, lineHeight: 1.85, marginBottom: 8 },
  stage: { fontSize: 18, marginTop: 8 },
  minutes: { fontSize: 40, fontWeight: 700, color: "#2f5d3a", margin: "10px 0 4px" },
  track: {
    height: 10, background: "#e8e3d8", borderRadius: 999, overflow: "hidden",
    margin: "14px 0 18px",
  },
  fill: { height: "100%", background: "#2f5d3a", transition: "width 400ms ease" },
  video: {
    width: "100%", borderRadius: 14, background: "#000", marginTop: 6,
    aspectRatio: "9 / 16", objectFit: "contain",
  },
  shelf: { marginTop: 26 },
  surprise: {
    width: "100%", marginTop: 10, padding: "13px 20px", fontSize: 16.5, fontWeight: 600,
    color: "#2f5d3a", background: "none", border: "1.5px solid #a9c1ae", borderRadius: 12,
    cursor: "pointer", fontFamily: "inherit",
  },
  makingList: { listStyle: "none", margin: 0, padding: 0 },
  makingRow: {
    background: "#fff", borderRadius: 14, padding: "14px 16px", marginTop: 10,
    boxShadow: "0 2px 10px rgba(60,50,35,0.07)",
  },
  makingTitle: { fontSize: 17, fontWeight: 600, color: "#2f2a22", lineHeight: 1.45 },
  makingStage: { fontSize: 14.5, color: "#2f5d3a", marginTop: 5 },
  makingStageBad: { fontSize: 14.5, color: "#8f403a", marginTop: 5 },
  makingRetry: {
    marginTop: 10, background: "none", border: "1.5px solid #d9b2ae", borderRadius: 999,
    padding: "7px 16px", fontSize: 14.5, color: "#8f403a", cursor: "pointer",
    fontFamily: "inherit",
  },
  h2: { fontSize: 18, fontWeight: 700, margin: "0 0 6px", color: "#3b352c" },
  shelfLabel: {
    fontSize: 13, textTransform: "uppercase", letterSpacing: 0.7,
    color: "#8d8577", margin: "16px 0 8px",
  },
  // Two columns on a phone, more when there is room. auto-fill rather than a fixed count so
  // the same grid works on her phone and on a laptop with no media query.
  grid: {
    display: "grid", gap: 12,
    gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))",
  },
  card2: {
    background: "#fff", border: "none", borderRadius: 14, padding: 0,
    overflow: "hidden", cursor: "pointer", textAlign: "left",
    boxShadow: "0 2px 10px rgba(60,50,35,0.08)", fontFamily: "inherit",
  },
  thumbWrap: { position: "relative", lineHeight: 0 },
  // 9:16 posters, so a card is tall like the video it opens.
  thumb: { width: "100%", aspectRatio: "9 / 16", objectFit: "cover", display: "block" },
  badge: {
    position: "absolute", right: 6, bottom: 6, background: "rgba(0,0,0,0.66)",
    color: "#fff", fontSize: 12, padding: "2px 7px", borderRadius: 999,
  },
  cardTitle: {
    fontSize: 14, lineHeight: 1.45, padding: "9px 10px 11px", color: "#2f2a22",
  },
  back: {
    background: "none", border: "none", padding: 0, marginBottom: 10,
    fontSize: 15, color: "#6b6257", cursor: "pointer", fontFamily: "inherit",
  },
  problem: {
    background: "#fdeceb", border: "1.5px solid #e8b7b3", borderRadius: 12,
    padding: "14px 16px", marginBottom: 18, fontSize: 15, lineHeight: 1.6,
  },
  problemText: { marginTop: 6, color: "#7a3b36", wordBreak: "break-word" },
};
