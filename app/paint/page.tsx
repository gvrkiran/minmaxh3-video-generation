"use client";

/**
 * Rangulu -- type one idea, get a little video of a painting being made.
 *
 * The sibling of /garden, built the same way and for the same reader: four screens, strictly
 * linear, one decision on each, no seed, no model name, no percentages, waiting described in
 * minutes. Telugu is the default; English is the toggle.
 *
 * What is different is the idea box. A gardening tip has to be a sentence; a painting idea
 * can be one word -- a subject, a medium, a colour, a mood -- and the model fills in the
 * rest. And where the tip page has nothing to suggest (only she knows her tips), this one
 * has a "Surprise me" that asks the model for an idea that is new here: it is shown every
 * painting already made or queued and told to stay away from them (`/api/paint/idea`). It
 * fills the box rather than starting straight away, so what is about to be made is always on
 * the screen first. If the model cannot be reached the built-in list answers instead, and
 * the page says so.
 *
 * The home screen also shows what is being made right now -- started from this phone an hour
 * ago, or from a list on /paint1 -- because "where is my video" must be answerable without
 * knowing its address. Tapping one opens its progress; tapping one that stopped carries it on.
 *
 * The plan screen exists for the same reason as on /garden: a video costs about twenty
 * minutes of graphics card, and seeing the lines first turns a twenty-minute mistake into a
 * five-second one.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { surpriseIdea } from "@/lib/paint-ideas";

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

type Stage = "idle" | "narrating" | "rendering" | "assembling" | "done" | "failed";

type Progress = {
  slug: string;
  titleTe: string;
  stage: Stage;
  label: string;
  shotsDone: number;
  shotsTotal: number;
  minutesLeft: number | null;
  ready: boolean;
  video: string | null;
  failed?: string;
};

type Active = {
  slug: string;
  titleTe: string;
  titleEn: string;
  idea: string;
  stage: Stage | "waiting" | "stopped";
  label: string;
  shotsDone: number;
  shotsTotal: number;
  minutesLeft: number | null;
  failed: string | null;
};

const COPY = {
  te: {
    brand: "రంగులు",
    tagline: "ఒక ఆలోచన చెప్పండి, అందమైన చిత్రం గీసే వీడియో తయారవుతుంది",
    listLink: "జాబితాగా చేయండి",
    prompt: "ఏ చిత్రం గీయాలి?",
    help: "బొమ్మ, రంగులు, పద్ధతి — ఏదైనా చెప్పండి. తెలుగులో రాయండి, లేదా ఇంగ్లీషు అక్షరాలతో తెలుగు రాసినా సరిపోతుంది. ఏమీ తోచకపోతే కింద నొక్కండి.",
    placeholder: "ఉదా: వర్షంలో పల్లెటూరు, వాటర్ కలర్‌లో · మధుబని పద్ధతిలో నెమలి · గోడ మీద వర్లి బొమ్మలు",
    surprise: "నన్ను ఆశ్చర్యపరచండి",
    thinking: "కొత్త ఆలోచన వెతుకుతున్నాను...",
    offlineIdea: "ఆలోచనల మోడల్ అందలేదు; ఇది సిద్ధంగా ఉన్న జాబితా నుంచి తీసుకున్నది.",
    write: "ముందుకు సాగండి",
    writing: "మీ ఆలోచనను చదువుతున్నాను...",
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
    inEnglish: "English",
    active: "ఇప్పుడు తయారవుతున్నవి",
    tapToWatch: "చూడటానికి నొక్కండి",
    tapToResume: "మళ్ళీ మొదలుపెట్టడానికి నొక్కండి",
    library: "అన్ని చిత్రాలు",
    mine: "నేను చేసినవి",
    empty: "ఇంకా వీడియోలు లేవు. మొదటిది మీరే చేయండి.",
    back: "వెనక్కి",
    newVideo: "కొత్త వీడియో",
    stages: {
      waiting: "గ్రాఫిక్స్ కార్డ్ కోసం వేచి ఉంది",
      queued: "జాబితాలో వేచి ఉంది",
      planning: "ప్రణాళిక రాస్తున్నాను",
      idle: "సిద్ధమవుతోంది",
      narrating: "గొంతు రికార్డు అవుతోంది",
      rendering: "బొమ్మ {n} / {m} తయారవుతోంది",
      assembling: "కలుపుతున్నాను",
      done: "సిద్ధం",
      failed: "ఏదో తేడా వచ్చింది",
      stopped: "పూర్తవకుండా ఆగిపోయింది",
    },
  },
  en: {
    brand: "Rangulu",
    tagline: "Tell it one idea, watch a painting being made",
    listLink: "make a list",
    prompt: "What should the painting be?",
    help: "A subject, a medium, a colour, a mood -- anything. Telugu, Telugu in English letters, or English. Stuck? Press the button below.",
    placeholder: "e.g. monsoon over a village, in watercolour · a peacock in Madhubani · Warli figures on a mud wall",
    surprise: "Surprise me",
    thinking: "Thinking of one...",
    offlineIdea: "The idea model could not be reached, so this one is from the built-in list.",
    write: "Carry on",
    writing: "Reading your idea...",
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
    inEnglish: "తెలుగు",
    active: "Being made now",
    tapToWatch: "Tap to watch",
    tapToResume: "Tap to carry on",
    library: "All paintings",
    mine: "Made here",
    empty: "No videos yet. Make the first one.",
    back: "Back",
    newVideo: "New video",
    stages: {
      waiting: "Waiting for the graphics card",
      queued: "Waiting in the list",
      planning: "Writing the plan",
      idle: "Getting ready",
      narrating: "Recording the voice",
      rendering: "Making picture {n} of {m}",
      assembling: "Putting it together",
      done: "Ready",
      failed: "Something went wrong",
      stopped: "Stopped before it finished",
    },
  },
};

export default function Paint() {
  const [lang, setLang] = useState<"te" | "en">("te");
  const [screen, setScreen] = useState<Screen>("type");
  const [idea, setIdea] = useState("");
  const [busy, setBusy] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [library, setLibrary] = useState<LibraryItem[]>([]);
  const [active, setActive] = useState<Active[]>([]);
  const [watching, setWatching] = useState<LibraryItem | null>(null);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);
  // Ideas already offered in this sitting, so pressing the button twice never brings one back.
  const shown = useRef<string[]>([]);

  const t = COPY[lang];

  const loadLibrary = useCallback(async () => {
    try {
      const got = await fetch("/api/paint/library", { cache: "no-store" });
      const data = await got.json() as { items?: LibraryItem[] };
      setLibrary(data.items ?? []);
    } catch { /* the shelf is not worth an error banner; the next visit will fill it */ }
  }, []);

  const loadActive = useCallback(async () => {
    try {
      const got = await fetch("/api/paint/active", { cache: "no-store" });
      const data = await got.json() as { items?: Active[] };
      setActive(data.items ?? []);
    } catch { /* same: a dropped poll is not worth a banner */ }
  }, []);

  useEffect(() => { void loadLibrary(); }, [loadLibrary]);

  // What is being made refreshes every 10s while the home screen is open. Slower than the
  // making screen's 5s, because this is a glance, not a wait, and the machine behind it is
  // busy with a graphics card job. Torn down the moment she leaves the home screen.
  const onHome = screen === "type" || screen === "done";
  useEffect(() => {
    if (!onHome) return;
    void loadActive();
    const timer = setInterval(() => void loadActive(), 10_000);
    return () => clearInterval(timer);
  }, [onHome, loadActive]);

  const stopPolling = useCallback(() => {
    if (poll.current) { clearInterval(poll.current); poll.current = null; }
  }, []);

  // Poll while the render runs. Every 5s: a shot takes minutes, so anything faster is just
  // load on a machine that is busy with a graphics card job.
  const startPolling = useCallback((slug: string) => {
    stopPolling();
    const tick = async () => {
      try {
        const got = await fetch(`/api/paint/progress?slug=${encodeURIComponent(slug)}`,
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
      const got = await fetch("/api/paint/plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ idea }),
      });
      const data = await got.json();
      if (!got.ok) throw new Error(data.error ?? "Could not plan the painting.");
      setPlan(data.plan as Plan);
      setScreen("plan");
    } catch (caught) {
      setProblem(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Ask the model for one idea nobody here has made. The server already knows every reel and
   * list on disk; what only this page knows is what it has offered before and what is in the
   * box now, so those go along as things to avoid.
   */
  async function surprise() {
    setThinking(true);
    setProblem(null);
    try {
      const got = await fetch("/api/paint/idea", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ count: 1, avoid: [...shown.current, idea.trim()].filter(Boolean) }),
      });
      const data = await got.json() as { ideas?: string[]; source?: string; detail?: string };
      const next = data.ideas?.[0];
      if (!got.ok || !next) throw new Error(data.detail ?? "No idea came back.");
      shown.current.push(next);
      setIdea(next);
      if (data.source === "local") setProblem(t.offlineIdea);
    } catch {
      // Last resort, and said out loud: the built-in list, never a button that does nothing.
      const local = surpriseIdea();
      shown.current.push(local);
      setIdea(local);
      setProblem(t.offlineIdea);
    } finally {
      setThinking(false);
    }
  }

  async function makeVideo() {
    if (!plan) return;
    setBusy(true);
    setProblem(null);
    try {
      const got = await fetch("/api/paint/render", {
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

  /**
   * Open something from the "being made now" shelf. A running one is simply watched. One that
   * failed or stopped is started again first -- the pipeline keeps every finished picture, so
   * carrying on costs only what was actually lost -- and then watched.
   */
  async function openActive(item: Active) {
    setProblem(null);
    const resume = item.stage === "failed" || item.stage === "stopped";
    if (resume) {
      setBusy(true);
      try {
        const got = await fetch("/api/paint/render", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ slug: item.slug }),
        });
        const data = await got.json();
        if (!got.ok) throw new Error(data.error ?? "Could not start.");
        setProgress(data.progress as Progress);
      } catch (caught) {
        setProblem(caught instanceof Error ? caught.message : String(caught));
        return;
      } finally {
        setBusy(false);
      }
    } else {
      // The progress screen knows the pipeline's own stages; the shelf's two extra states both
      // mean "nothing to show yet" there.
      const stage: Stage = item.stage === "waiting" || item.stage === "stopped" ? "idle" : item.stage;
      setProgress({
        slug: item.slug, titleTe: item.titleTe, stage,
        label: item.label, shotsDone: item.shotsDone, shotsTotal: item.shotsTotal,
        minutesLeft: item.minutesLeft, ready: false, video: null,
      });
    }
    setPlan(null);
    setScreen("making");
    startPolling(item.slug);
  }

  function startOver() {
    stopPolling();
    setPlan(null); setProgress(null); setProblem(null); setIdea(""); setWatching(null);
    setScreen("type");
    void loadLibrary();
  }

  function watch(item: LibraryItem) {
    setWatching(item);
    setScreen("watch");
  }

  /** The stage of something being made, in her language. */
  function stageText(item: Active): string {
    const s = t.stages;
    if (item.stage === "waiting") {
      return item.label === "Waiting in the list" ? s.queued
        : item.label === "Writing the plan" ? s.planning
        : s.waiting;
    }
    if (item.stage === "rendering") {
      return s.rendering.replace("{n}", String(Math.min(item.shotsDone + 1, item.shotsTotal)))
        .replace("{m}", String(item.shotsTotal));
    }
    return s[item.stage] ?? item.label;
  }

  /** Cards for the shelf. Rendered under the typing box and on the done screen. */
  function Shelf() {
    if (!library.length) return <p style={S.help}>{t.empty}</p>;
    return (
      <>
        <div style={S.shelfLabel}>{t.mine}</div>
        <div style={S.grid}>{library.map((i) => <Card key={i.slug} item={i} />)}</div>
      </>
    );
  }

  /** What is being made right now, one row each, newest first. */
  function Active() {
    if (!active.length) return null;
    return (
      <section style={S.shelf}>
        <h2 style={S.h2}>{t.active}</h2>
        <div style={S.activeList}>
          {active.map((item) => {
            const title = (lang === "te" ? (item.titleTe || item.titleEn) : (item.titleEn || item.titleTe))
              || item.idea;
            const stalled = item.stage === "failed" || item.stage === "stopped";
            const pct = item.shotsTotal > 0
              ? Math.round((item.shotsDone / item.shotsTotal) * 100) : 0;
            return (
              <button
                key={item.slug}
                style={{ ...S.activeRow, ...(busy ? S.disabled : {}) }}
                disabled={busy}
                onClick={() => void openActive(item)}
              >
                <div style={S.activeTitle}>{title}</div>
                <div style={{ ...S.activeStage, ...(stalled ? S.activeStalled : {}) }}>
                  {stageText(item)}
                  {item.minutesLeft !== null && !stalled && ` · ${item.minutesLeft} ${t.minutes}`}
                </div>
                {!stalled && item.shotsTotal > 0 && (
                  <div style={S.trackSmall}>
                    <div style={{ ...S.fill, width: `${pct}%` }} />
                  </div>
                )}
                <div style={S.activeHint}>{stalled ? t.tapToResume : t.tapToWatch}</div>
              </button>
            );
          })}
        </div>
      </section>
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
              src={`/api/paint/file?slug=${encodeURIComponent(item.slug)}&rel=poster.jpg`}
            />
          ) : <div style={{ ...S.thumb, background: "#e4d8d1" }} />}
          {item.seconds !== null && (
            <span style={S.badge}>{Math.round(item.seconds)}s</span>
          )}
        </div>
        <div style={S.cardTitle}>{title}</div>
      </button>
    );
  }

  const tooShort = idea.trim().length < 2;

  return (
    <main style={S.page}>
      <header style={S.header}>
        <div>
          <div style={S.brand}>{t.brand}</div>
          <div style={S.tagline}>{t.tagline}</div>
          <a href="/paint1" style={S.link}>{t.listLink} &rarr;</a>
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
            value={idea}
            onChange={(e) => setIdea(e.target.value)}
            placeholder={t.placeholder}
            rows={4}
            autoFocus
          />
          <button
            style={{ ...S.primary, ...(busy || thinking || tooShort ? S.disabled : {}) }}
            disabled={busy || thinking || tooShort}
            onClick={() => void writePlan()}
          >
            {busy ? t.writing : t.write}
          </button>
          {/* Fills the box rather than starting: what is about to be made stays on screen,
              and she can change a word before spending twenty minutes of graphics card. */}
          <button
            style={{ ...S.secondary, ...(busy || thinking ? S.disabled : {}) }}
            disabled={busy || thinking}
            onClick={() => void surprise()}
          >
            {thinking ? t.thinking : t.surprise}
          </button>
        </section>
      )}

      {screen === "type" && <Active />}

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
              ? `/api/paint/file?slug=${encodeURIComponent(watching.slug)}&rel=poster.jpg`
              : undefined}
            src={`/api/paint/file?slug=${encodeURIComponent(watching.slug)}&rel=${encodeURIComponent(
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
          <button style={S.back} onClick={startOver}>&larr; {t.back}</button>
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
            src={`/api/paint/file?slug=${encodeURIComponent(progress.slug)}&rel=${encodeURIComponent(progress.video)}`}
          />
          <button style={S.primary} onClick={startOver}>{t.makeAnother}</button>
        </section>
      )}

      {screen === "done" && <Active />}

      {screen === "done" && (
        <section style={S.shelf}>
          <h2 style={S.h2}>{t.library}</h2>
          <Shelf />
        </section>
      )}
    </main>
  );
}

/* Inline styles, matching /garden -- this app ships no CSS framework, and a stylesheet for
   one page would be a second place to look. Same bones as the garden page, in madder red
   rather than leaf green so the two are never mistaken for each other on a phone. */
const ACCENT = "#8a2f4a";
const S: Record<string, React.CSSProperties> = {
  page: {
    minHeight: "100vh", background: "#f6f1ea", color: "#241f1a",
    fontFamily: "system-ui, 'Noto Sans Telugu', sans-serif",
    padding: "20px 16px 64px", maxWidth: 680, margin: "0 auto",
  },
  header: {
    display: "flex", justifyContent: "space-between", alignItems: "flex-start",
    gap: 12, marginBottom: 24,
  },
  brand: { fontSize: 30, fontWeight: 700, color: ACCENT, lineHeight: 1.2 },
  tagline: { fontSize: 15, color: "#6b6257", marginTop: 4 },
  link: { fontSize: 14, color: "#8d8577", display: "inline-block", marginTop: 8 },
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
    color: "#fff", background: ACCENT, border: "none", borderRadius: 12,
    cursor: "pointer", fontFamily: "inherit",
  },
  secondary: {
    width: "100%", marginTop: 10, padding: "13px 20px", fontSize: 16,
    color: "#6b6257", background: "none", border: "none", cursor: "pointer",
    fontFamily: "inherit", textDecoration: "underline",
  },
  disabled: { opacity: 0.45, cursor: "default" },
  planTitle: { fontSize: 21, fontWeight: 700, color: ACCENT, margin: "4px 0 18px" },
  label: {
    fontSize: 13, textTransform: "uppercase", letterSpacing: 0.7,
    color: "#8d8577", marginTop: 16, marginBottom: 6,
  },
  understood: { fontSize: 16, lineHeight: 1.6, margin: 0, color: "#4a443a" },
  lines: { margin: "0", paddingLeft: 22 },
  line: { fontSize: 18, lineHeight: 1.85, marginBottom: 8 },
  stage: { fontSize: 18, marginTop: 8 },
  minutes: { fontSize: 40, fontWeight: 700, color: ACCENT, margin: "10px 0 4px" },
  track: {
    height: 10, background: "#ebe4da", borderRadius: 999, overflow: "hidden",
    margin: "14px 0 18px",
  },
  trackSmall: {
    height: 6, background: "#ebe4da", borderRadius: 999, overflow: "hidden",
    margin: "8px 0 6px",
  },
  fill: { height: "100%", background: ACCENT, transition: "width 400ms ease" },
  video: {
    width: "100%", borderRadius: 14, background: "#000", marginTop: 6,
    aspectRatio: "9 / 16", objectFit: "contain",
  },
  shelf: { marginTop: 26 },
  h2: { fontSize: 18, fontWeight: 700, margin: "0 0 6px", color: "#3b352c" },
  shelfLabel: {
    fontSize: 13, textTransform: "uppercase", letterSpacing: 0.7,
    color: "#8d8577", margin: "16px 0 8px",
  },
  activeList: { display: "flex", flexDirection: "column", gap: 10, marginTop: 8 },
  // A row, not a poster card: there is no picture yet, and the words are the point.
  activeRow: {
    background: "#fff", border: "none", borderRadius: 14, padding: "14px 16px",
    textAlign: "left", cursor: "pointer", fontFamily: "inherit", width: "100%",
    boxShadow: "0 2px 10px rgba(60,50,35,0.08)", color: "#241f1a",
  },
  activeTitle: { fontSize: 17, fontWeight: 600, lineHeight: 1.4 },
  activeStage: { fontSize: 15, color: ACCENT, marginTop: 4 },
  activeStalled: { color: "#8f403a" },
  activeHint: { fontSize: 13, color: "#8d8577", marginTop: 4 },
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
