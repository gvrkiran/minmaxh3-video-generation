"use client";

/**
 * Kathalu Studio -- six screens, strictly linear, one decision each.
 *
 * The person using this is not a technologist. There is no seed, no step count, no
 * megapixels, no model name and no aspect-ratio jargon anywhere on screen. Waiting is
 * always described in minutes, never in percent. Every label is written from her side of
 * the screen: "Making scene 3 of 8", not "rendering job queued".
 */

import { useCallback, useEffect, useRef, useState } from "react";

type Screen = "home" | "source" | "check" | "cast" | "listen" | "making" | "review";

type Failure = {
  step: string;
  kind: "network" | "timeout" | "server";
  message: string;      // for her
  detail: string;       // for whoever fixes it
  ref: string;          // she reads this out; the server logged the same code
  hint?: string;        // what to do about it
  seconds: number;
};

type Filled = { before: string; inserted: string; after: string; confidence: string };
type Character = {
  key: string; name: string; species: string; role: string;
  appearance: string; portrait: string;
};
type Scene = {
  index: number; summary: string; telugu: string;
  seconds?: number; hasAudio: boolean; hasShot: boolean; audio?: string;
};
type Progress = {
  stage: "idle" | "narrating" | "rendering" | "assembling" | "done";
  label: string; scenesDone: number; scenesTotal: number;
  minutesLeft: number | null; finalReady: boolean; scenes: Scene[]; failed?: string;
};
type PastStory = {
  dir: string; title: string; teluguTitle: string; scenes: number;
  megabytes: number; video: string;
};

const COPY = {
  en: {
    brand: "Kathalu Studio", tagline: "Turn a story into a little film",
    myVideos: "My story videos", makeNew: "Make a new video",
    noneYet: "No videos yet. Let's make the first one.",
    whereFrom: "Where's the story?", typeIt: "Type or paste a story",
    typeItSub: "Write it out, or paste it in.",
    photographIt: "Photograph the pages", photographItSub: "Pictures of a book you have.",
    photoTip: "Lay the book flat and fill the picture with the page. Take one photo per page, in order.",
    addPhotos: "Choose photos", shape: "Where will you watch it?",
    forPhone: "On a phone", forTv: "On a TV", read: "Read the story",
    isThis: "Is this the story?", isThisSub: "Change anything that looks wrong.",
    filledInTitle: "I filled in a few words the photo cut off",
    filledInSub: "Please check these against the book.",
    meetThem: "Meet the characters", meetThemSub: "Drawn in the style of your book.",
    tryAgain: "Try again", changeIt: "Change something…",
    changePrompt: "What should be different?", apply: "Redraw",
    planScenes: "Plan the scenes", listen: "Listen to the telling",
    listenSub: "Hear it before the video is made. Change any line you like.",
    play: "Play", makeMyVideo: "Make my video",
    making: "Making your video", makingSub: "You can close this and come back later.",
    ready: "Your video is ready", download: "Download", makeAnother: "Make another",
    back: "Back", working: "Working…", somethingWrong: "Something went wrong",
    startOver: "Start over", scene: "Scene",
    tellThem: "What to tell Kiran", copyIt: "Copy this",
    checkScenes: "Check each scene", reviewTitle: "How does each scene look?",
    reviewSub: "Watch them one at a time. If one is wrong, say what is wrong and I will make it again.",
    whatsWrong: "What is wrong with this scene?",
    redoScene: "Make this scene again", redoing: "Making this scene again",
    backToVideo: "Back to the video", moralIs: "The lesson", moralComposed: "written for this story",
    moralPrinted: "from the book",
  },
  te: {
    brand: "కథలు స్టూడియో", tagline: "కథను చిన్న సినిమాగా మార్చండి",
    myVideos: "నా కథల వీడియోలు", makeNew: "కొత్త వీడియో చేయండి",
    noneYet: "ఇంకా వీడియోలు లేవు. మొదటిది చేద్దాం.",
    whereFrom: "కథ ఎక్కడ ఉంది?", typeIt: "కథను టైప్ చేయండి",
    typeItSub: "రాయండి, లేదా అతికించండి.",
    photographIt: "పేజీల ఫోటోలు తీయండి", photographItSub: "మీ దగ్గర ఉన్న పుస్తకం ఫోటోలు.",
    photoTip: "పుస్తకాన్ని చదునుగా పెట్టి, పేజీ మొత్తం ఫోటోలో వచ్చేలా తీయండి. ఒక పేజీకి ఒక ఫోటో, వరుసగా.",
    addPhotos: "ఫోటోలు ఎంచుకోండి", shape: "ఎక్కడ చూస్తారు?",
    forPhone: "ఫోన్‌లో", forTv: "టీవీలో", read: "కథను చదవండి",
    isThis: "కథ ఇదేనా?", isThisSub: "తప్పుగా ఉన్నది మార్చండి.",
    filledInTitle: "ఫోటోలో కనిపించని కొన్ని పదాలు నేను నింపాను",
    filledInSub: "వీటిని పుస్తకంతో సరిచూడండి.",
    meetThem: "పాత్రలను చూడండి", meetThemSub: "మీ పుస్తకం శైలిలో గీసినవి.",
    tryAgain: "మళ్ళీ ప్రయత్నించండి", changeIt: "ఏదైనా మార్చండి…",
    changePrompt: "ఏమి మారాలి?", apply: "మళ్ళీ గీయండి",
    planScenes: "సన్నివేశాలు సిద్ధం చేయండి", listen: "కథనం వినండి",
    listenSub: "వీడియో చేయకముందే వినండి. ఏ వాక్యాన్నైనా మార్చవచ్చు.",
    play: "వినండి", makeMyVideo: "నా వీడియో చేయండి",
    making: "మీ వీడియో తయారవుతోంది", makingSub: "ఇది మూసేసి తర్వాత రావచ్చు.",
    ready: "మీ వీడియో సిద్ధం", download: "డౌన్‌లోడ్", makeAnother: "మరొకటి చేయండి",
    back: "వెనుకకు", working: "జరుగుతోంది…", somethingWrong: "ఏదో తప్పు జరిగింది",
    startOver: "మొదటి నుంచి", scene: "సన్నివేశం",
    tellThem: "కిరణ్‌కి ఏమి చెప్పాలి", copyIt: "ఇది కాపీ చేయండి",
    checkScenes: "ఒక్కో సన్నివేశం చూడండి", reviewTitle: "ప్రతి సన్నివేశం ఎలా ఉంది?",
    reviewSub: "ఒక్కొక్కటి చూడండి. ఏదైనా సరిగా లేకపోతే, ఏమి తప్పు అని చెప్పండి, మళ్ళీ చేస్తాను.",
    whatsWrong: "ఈ సన్నివేశంలో ఏమి తప్పు?",
    redoScene: "ఈ సన్నివేశం మళ్ళీ చేయండి", redoing: "ఈ సన్నివేశం మళ్ళీ తయారవుతోంది",
    backToVideo: "వీడియోకు తిరిగి", moralIs: "నీతి", moralComposed: "ఈ కథ కోసం రాసినది",
    moralPrinted: "పుస్తకం నుంచి",
  },
} as const;

export default function StoryStudio() {
  const [lang, setLang] = useState<"en" | "te">("en");
  const t = COPY[lang];

  const [screen, setScreen] = useState<Screen>("home");
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);

  const [past, setPast] = useState<PastStory[]>([]);
  const [aspect, setAspect] = useState<"9:16" | "16:9">("9:16");
  const [typed, setTyped] = useState("");
  const [photos, setPhotos] = useState<File[]>([]);

  const [storyDir, setStoryDir] = useState("");
  const [title, setTitle] = useState("");
  const [storyText, setStoryText] = useState("");
  const [moral, setMoral] = useState("");
  const [filledIn, setFilledIn] = useState<Filled[]>([]);
  const [note, setNote] = useState("");

  const [characters, setCharacters] = useState<Character[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [editNote, setEditNote] = useState("");

  const [scenes, setScenes] = useState<Scene[]>([]);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [sceneNotes, setSceneNotes] = useState<Record<number, string>>({});
  const [redoing, setRedoing] = useState<number | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const errorRef = useRef<HTMLDivElement | null>(null);

  const loadPast = useCallback(async () => {
    const got = await fetch("/api/story/list").then((r) => r.json()).catch(() => ({ stories: [] }));
    setPast(got.stories ?? []);
  }, []);

  useEffect(() => { void loadPast(); }, [loadPast]);

  // Bring a failure into view. Sticky positioning is not enough on its own if she is
  // already scrolled past it when the request comes back.
  useEffect(() => {
    if (failure) errorRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [failure]);

  // Polling stops as soon as the film exists, so a finished tab is not a busy tab.
  useEffect(() => {
    if ((screen !== "making" && screen !== "review") || !storyDir) return;
    const tick = async () => {
      const got = await fetch(`/api/story/progress?dir=${encodeURIComponent(storyDir)}`)
        .then((r) => r.json()).catch(() => null);
      if (got && !got.error) {
        setProgress(got);
        if (got.finalReady && pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
          setRedoing(null);
          void loadPast();
        }
      }
    };
    void tick();
    pollRef.current = setInterval(tick, 5000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [screen, storyDir, loadPast]);

  /**
   * Long steps here take minutes -- drawing a cast can take four if the video model has to
   * be swapped out of the graphics card first. A plain "Failed to fetch" is what the browser
   * says when the connection drops during that, and it tells her nothing about whether her
   * work survived. So the three cases are separated and each says what to do next.
   */
  async function call<T>(url: string, init: RequestInit, label: string,
                         budgetMs = 900_000): Promise<T | null> {
    setBusy(label);
    setFailure(null);
    const startedAt = Date.now();
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort("timeout"), budgetMs);
    try {
      const response = await fetch(url, { ...init, signal: abort.signal });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.error) {
        setFailure({
          step: label,
          kind: "server",
          message: payload.error || `The studio could not finish "${label}".`,
          hint: payload.hint,
          detail: [payload.detail, `HTTP ${response.status} from ${url}`]
            .filter(Boolean).join(" | "),
          ref: payload.ref || "",
          seconds: Math.round((Date.now() - startedAt) / 1000),
        });
        return null;
      }
      return payload as T;
    } catch (caught) {
      const seconds = Math.round((Date.now() - startedAt) / 1000);
      const timedOut = abort.signal.aborted;
      setFailure({
        step: label,
        kind: timedOut ? "timeout" : "network",
        message: timedOut
          ? `"${label}" ran for ${Math.round(seconds / 60)} minutes and I stopped waiting. `
            + "It may still be finishing on the studio computer. Wait a minute, then press the "
            + "same button again -- anything already done is kept."
          : `The connection to the studio computer dropped during "${label}", after `
            + `${seconds} seconds. You did nothing wrong: the studio may have restarted, or `
            + "the network dropped. Press the same button again -- anything already finished "
            + "is kept, so it will not start over.",
        detail: [caught instanceof Error ? `${caught.name}: ${caught.message}` : String(caught),
                 `after ${seconds}s`, url].join(" | "),
        ref: new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14),
        seconds,
      });
      return null;
    } finally {
      clearTimeout(timer);
      setBusy(null);
    }
  }

  async function readStory() {
    const form = new FormData();
    if (photos.length) photos.forEach((p) => form.append("photos", p));
    else form.set("text", typed);
    const got = await call<any>("/api/story/ingest", { method: "POST", body: form }, t.read);
    if (!got) return;
    setStoryDir(got.storyDir);
    setTitle(got.title);
    setStoryText(got.storyText);
    setMoral(got.moral ?? "");
    setFilledIn(got.filledIn ?? []);
    setNote(got.note ?? "");
    setScreen("check");
  }

  async function buildCast() {
    const got = await call<any>("/api/story/cast",
      { method: "POST", headers: { "content-type": "application/json" },
        // send her corrections so they are saved, not merely displayed
        body: JSON.stringify({ storyDir, title, storyText }) }, t.meetThem);
    if (!got) return;
    setCharacters(got.characters ?? []);
    setScreen("cast");
  }

  async function redraw(key: string, withNote: string) {
    const got = await call<any>("/api/story/cast",
      { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ storyDir, redraw: key, note: withNote }) }, t.tryAgain);
    // Only close the note box if it actually worked. Clearing it on failure looked
    // exactly like nothing had happened, and threw away what she had typed.
    if (!got) return;
    setCharacters(got.characters ?? []);
    setEditing(null);
    setEditNote("");
  }

  async function planScenes() {
    const got = await call<any>("/api/story/script",
      { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ storyDir }) }, t.planScenes);
    if (!got) return;
    setScenes(got.scenes ?? []);
    setScreen("listen");
  }

  async function makeVideo() {
    const got = await call<any>("/api/story/render",
      { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ storyDir, aspect }) }, t.makeMyVideo);
    if (!got) return;
    setProgress(got.progress ?? null);
    setScreen("making");
  }

  async function redoScene(index: number) {
    const got = await call<any>("/api/story/scene",
      { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ storyDir, index, note: sceneNotes[index] ?? "", aspect }) },
      t.redoScene);
    if (!got) return;
    // Clear the note only once it has been accepted, and keep polling running so the
    // dots and the estimate update in place rather than the screen going quiet.
    setSceneNotes((prev) => ({ ...prev, [index]: "" }));
    setRedoing(index);
    setProgress(got.progress ?? null);
  }

  function reset() {
    setScreen("home"); setTyped(""); setPhotos([]); setStoryDir(""); setTitle("");
    setStoryText(""); setMoral(""); setFilledIn([]); setNote("");
    setCharacters([]); setScenes([]); setProgress(null); setFailure(null);
    setSceneNotes({}); setRedoing(null);
    void loadPast();
  }

  return (
    <main className="ks">
      <header className="ks-top">
        <div className="ks-brand">
          <span className="ks-mark">క</span>
          <span><strong>{t.brand}</strong><small>{t.tagline}</small></span>
        </div>
        <button className="ks-lang" onClick={() => setLang(lang === "en" ? "te" : "en")}>
          {lang === "en" ? "తెలుగు" : "English"}
        </button>
      </header>

      {failure && (
        <div className="ks-error" role="alert" ref={errorRef}>
          <div className="ks-error-body">
            <strong>{t.somethingWrong}</strong>
            <p className="ks-error-msg">{failure.message}</p>
            {failure.hint && <p className="ks-error-hint">{failure.hint}</p>}
            <details>
              <summary>{t.tellThem}</summary>
              <pre className="ks-error-detail">{[
                `step:    ${failure.step}`,
                `problem: ${failure.kind}`,
                `ref:     ${failure.ref}`,
                `after:   ${failure.seconds}s`,
                `detail:  ${failure.detail}`,
              ].join(String.fromCharCode(10))}</pre>
              <button
                onClick={() => navigator.clipboard?.writeText([
                  `Kathalu Studio problem`,
                  `step: ${failure.step}`,
                  `problem: ${failure.kind}`,
                  `ref: ${failure.ref}`,
                  `after: ${failure.seconds}s`,
                  `detail: ${failure.detail}`,
                ].join(String.fromCharCode(10)))}
              >
                {t.copyIt}
              </button>
            </details>
          </div>
          <button className="ks-error-x" onClick={() => setFailure(null)}
            aria-label="Close">×</button>
        </div>
      )}

      {busy && (
        <div className="ks-busy" role="status">
          <span className="ks-spin" aria-hidden="true" />
          {busy}… {t.working}
        </div>
      )}

      {/* ---------------------------------------------------------- 1. home */}
      {screen === "home" && (
        <section className="ks-screen">
          <h1>{t.myVideos}</h1>
          <button className="ks-go" onClick={() => setScreen("source")}>{t.makeNew}</button>
          {past.length === 0 ? (
            <p className="ks-empty">{t.noneYet}</p>
          ) : (
            <div className="ks-grid">
              {past.map((s) => (
                <figure key={s.dir} className="ks-card">
                  <video src={s.video} controls preload="metadata" />
                  <figcaption>
                    <strong>{s.title}</strong>
                    <small>
                      {s.teluguTitle} · {s.scenes} {lang === "en" && s.scenes !== 1
                        ? `${t.scene.toLowerCase()}s` : t.scene.toLowerCase()} · {s.megabytes} MB
                    </small>
                  </figcaption>
                </figure>
              ))}
            </div>
          )}
        </section>
      )}

      {/* -------------------------------------------------------- 2. source */}
      {screen === "source" && (
        <section className="ks-screen">
          <h1>{t.whereFrom}</h1>
          <div className="ks-two">
            <div className="ks-choice">
              <h2>{t.typeIt}</h2>
              <p>{t.typeItSub}</p>
              <textarea value={typed} onChange={(e) => { setTyped(e.target.value); setPhotos([]); }} rows={9} />
            </div>
            <div className="ks-choice">
              <h2>{t.photographIt}</h2>
              <p>{t.photographItSub}</p>
              <p className="ks-tip">{t.photoTip}</p>
              <label className="ks-file">
                {t.addPhotos}
                <input type="file" accept="image/*" multiple
                  onChange={(e) => { setPhotos(Array.from(e.target.files ?? [])); setTyped(""); }} />
              </label>
              {photos.length > 0 && (
                <ol className="ks-pages">
                  {photos.map((p, i) => <li key={p.name + i}>{i + 1}. {p.name}</li>)}
                </ol>
              )}
            </div>
          </div>

          <fieldset className="ks-shape">
            <legend>{t.shape}</legend>
            <button className={aspect === "9:16" ? "on" : ""} onClick={() => setAspect("9:16")}>
              <span className="ks-phone" aria-hidden="true" />{t.forPhone}
            </button>
            <button className={aspect === "16:9" ? "on" : ""} onClick={() => setAspect("16:9")}>
              <span className="ks-tv" aria-hidden="true" />{t.forTv}
            </button>
          </fieldset>

          <div className="ks-nav">
            <button className="ks-back" onClick={() => setScreen("home")}>{t.back}</button>
            <button className="ks-go" disabled={Boolean(busy) || (!typed.trim() && !photos.length)}
              onClick={readStory}>{t.read}</button>
          </div>
        </section>
      )}

      {/* --------------------------------------------------------- 3. check */}
      {screen === "check" && (
        <section className="ks-screen">
          <h1>{t.isThis}</h1>
          <p className="ks-sub">{t.isThisSub}</p>
          <input className="ks-title" value={title} onChange={(e) => setTitle(e.target.value)} />
          <textarea className="ks-story" value={storyText}
            onChange={(e) => setStoryText(e.target.value)} rows={16} />
          {moral && <p className="ks-moral"><em>{moral}</em></p>}

          {filledIn.length > 0 && (
            <div className="ks-filled">
              <h3>{t.filledInTitle}</h3>
              <p>{note || t.filledInSub}</p>
              <ul>
                {filledIn.map((f, i) => (
                  <li key={i}>
                    <span className="dim">…{f.before.slice(-40)}</span>
                    <mark>{f.inserted}</mark>
                    <span className="dim">{f.after.slice(0, 34)}…</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="ks-nav">
            <button className="ks-back" onClick={() => setScreen("source")}>{t.back}</button>
            <button className="ks-go" disabled={Boolean(busy)} onClick={buildCast}>{t.meetThem}</button>
          </div>
        </section>
      )}

      {/* ---------------------------------------------------------- 4. cast */}
      {screen === "cast" && (
        <section className="ks-screen">
          <h1>{t.meetThem}</h1>
          <p className="ks-sub">{t.meetThemSub}</p>
          <div className="ks-grid">
            {characters.map((c) => (
              <figure key={c.key} className="ks-card">
                <img src={c.portrait} alt={c.name} />
                <figcaption>
                  <strong>{c.name}</strong>
                  <small>{c.role}</small>
                  {editing === c.key ? (
                    <div className="ks-edit">
                      <label htmlFor={`n-${c.key}`}>{t.changePrompt}</label>
                      <input id={`n-${c.key}`} value={editNote} autoFocus
                        onChange={(e) => setEditNote(e.target.value)} />
                      <button disabled={Boolean(busy)} onClick={() => redraw(c.key, editNote)}>
                        {t.apply}
                      </button>
                    </div>
                  ) : (
                    <div className="ks-row">
                      <button disabled={Boolean(busy)} onClick={() => redraw(c.key, "")}>
                        {t.tryAgain}
                      </button>
                      <button disabled={Boolean(busy)}
                        onClick={() => { setEditing(c.key); setEditNote(""); }}>
                        {t.changeIt}
                      </button>
                    </div>
                  )}
                </figcaption>
              </figure>
            ))}
          </div>
          <div className="ks-nav">
            <button className="ks-back" onClick={() => setScreen("check")}>{t.back}</button>
            <button className="ks-go" disabled={Boolean(busy) || !characters.length}
              onClick={planScenes}>{t.planScenes}</button>
          </div>
        </section>
      )}

      {/* -------------------------------------------------------- 5. listen */}
      {screen === "listen" && (
        <section className="ks-screen">
          <h1>{t.listen}</h1>
          <p className="ks-sub">{t.listenSub}</p>
          <ol className="ks-scenes">
            {scenes.map((s) => (
              <li key={s.index}>
                <span className="ks-num">{s.index}</span>
                <div>
                  <p className="ks-what">{s.summary}</p>
                  <p className="ks-te">{s.telugu}</p>
                  {s.audio && <audio src={s.audio} controls preload="none" />}
                </div>
                {s.seconds && <span className="ks-secs">{s.seconds.toFixed(1)}s</span>}
              </li>
            ))}
          </ol>
          <div className="ks-nav">
            <button className="ks-back" onClick={() => setScreen("cast")}>{t.back}</button>
            <button className="ks-go" disabled={Boolean(busy)} onClick={makeVideo}>{t.makeMyVideo}</button>
          </div>
        </section>
      )}

      {/* -------------------------------------------------------- 6. making */}
      {screen === "making" && (
        <section className="ks-screen">
          <h1>{progress?.finalReady ? t.ready : t.making}</h1>
          {!progress?.finalReady && <p className="ks-sub">{t.makingSub}</p>}

          {progress && !progress.finalReady && (
            <div className="ks-progress">
              <p className="ks-stage">{progress.label}</p>
              {progress.minutesLeft !== null && (
                <p className="ks-eta">about {progress.minutesLeft} minute{progress.minutesLeft === 1 ? "" : "s"} left</p>
              )}
              <div className="ks-dots">
                {progress.scenes.map((s) => (
                  <span key={s.index} className={s.hasShot ? "done" : s.hasAudio ? "part" : ""}>
                    {s.index}
                  </span>
                ))}
              </div>
            </div>
          )}

          {progress?.finalReady && (
            <>
              <video className="ks-final" controls autoPlay
                src={`/api/story/file?dir=${encodeURIComponent(storyDir)}&rel=final.mp4`} />
              <div className="ks-nav">
                <a className="ks-go" download
                  href={`/api/story/file?dir=${encodeURIComponent(storyDir)}&rel=final.mp4`}>
                  {t.download}
                </a>
                <button className="ks-back" onClick={() => setScreen("review")}>{t.checkScenes}</button>
                <button className="ks-back" onClick={reset}>{t.makeAnother}</button>
              </div>
            </>
          )}

          {progress?.failed && !progress.finalReady && (
            <details className="ks-detail">
              <summary>{t.tellThem}</summary>
              <pre>{progress.failed}</pre>
              <button onClick={makeVideo}>{t.makeMyVideo}</button>
            </details>
          )}
        </section>
      )}

      {/* -------------------------------------------------------- 7. review */}
      {screen === "review" && (
        <section className="ks-screen">
          <h1>{t.reviewTitle}</h1>
          <p className="ks-sub">{t.reviewSub}</p>

          {progress && !progress.finalReady && (
            <div className="ks-progress">
              <p className="ks-stage">
                {redoing ? `${t.redoing} ${redoing}` : progress.label}
              </p>
              {progress.minutesLeft !== null && (
                <p className="ks-eta">
                  about {progress.minutesLeft} minute{progress.minutesLeft === 1 ? "" : "s"} left
                </p>
              )}
            </div>
          )}

          <ol className="ks-scenes ks-review">
            {(progress?.scenes ?? []).map((s) => (
              <li key={s.index}>
                <span className="ks-num">{s.index}</span>
                <div>
                  <p className="ks-what">{s.summary}</p>
                  {s.hasShot ? (
                    <video
                      className="ks-scene-video"
                      controls
                      preload="metadata"
                      src={`/api/story/file?dir=${encodeURIComponent(storyDir)}&rel=${encodeURIComponent(`narrated/scene_${String(s.index).padStart(2, "0")}.mp4`)}`}
                    />
                  ) : (
                    <p className="ks-eta">{t.working}</p>
                  )}
                  <p className="ks-te">{s.telugu}</p>
                  <div className="ks-edit">
                    <label htmlFor={`w-${s.index}`}>{t.whatsWrong}</label>
                    <input
                      id={`w-${s.index}`}
                      value={sceneNotes[s.index] ?? ""}
                      onChange={(e) =>
                        setSceneNotes((prev) => ({ ...prev, [s.index]: e.target.value }))}
                    />
                    <button
                      disabled={Boolean(busy) || redoing !== null}
                      onClick={() => redoScene(s.index)}
                    >
                      {t.redoScene}
                    </button>
                  </div>
                </div>
                {s.seconds && (
                  <span className="ks-secs">{s.seconds.toFixed(1)}s</span>
                )}
              </li>
            ))}
          </ol>

          <div className="ks-nav">
            <button className="ks-back" onClick={() => setScreen("making")}>
              {t.backToVideo}
            </button>
          </div>
        </section>
      )}
    </main>
  );
}
