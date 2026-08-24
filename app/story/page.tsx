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

type Screen = "home" | "source" | "check" | "cast" | "listen" | "making" | "edit";

type Failure = {
  step: string;
  kind: "network" | "timeout" | "server";
  message: string;      // for her
  detail: string;       // for whoever fixes it
  ref: string;          // she reads this out; the server logged the same code
  hint?: string;        // what to do about it
  advice?: string[];    // things she can actually go and do, one per line
  seconds: number;
};

type Version = {
  id: string; length: "full" | "short"; language: "te" | "en"; rel: string; url: string;
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
  stage: "idle" | "waiting" | "narrating" | "rendering" | "assembling" | "done";
  label: string; scenesDone: number; scenesTotal: number;
  minutesLeft: number | null; finalReady: boolean; finalUpdatedAt: number | null;
  scenes: Scene[]; failed?: string;
};
type EditScene = {
  index: number; summary: string; telugu: string; characters: string[];
  seconds?: number; ready: boolean; video: string | null; audio: string | null;
  lastNote: string; lastChange: string;
};
type OpenStory = {
  storyDir: string; title: string; teluguTitle: string;
  moral: { telugu: string; english: string; source: string; video: string | null };
  finalVideo: string | null; scenes: EditScene[]; lastApplied: string[]; progress: Progress;
  versions?: Version[];
};
/** One row of pending intent. Nothing is sent for a scene she has not touched. */
type PendingEdit = { note: string; telugu: string; remove: boolean };

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
    edit: "Edit", editTitle: "Change your video",
    editSub: "Watch any scene. Say what is wrong with it, or fix the words the narrator says. Change as many as you like, then make the changes all at once.",
    wholeVideo: "The whole video", theLesson: "The lesson at the end",
    lengthLabel: "How long", voiceLabel: "Which voice",
    fullLength: "The whole story", shortLength: "30 seconds",
    inTelugu: "Telugu", inEnglish: "English",
    narratorSays: "What the narrator says", whatsWrongShort: "What is wrong with this scene?",
    leaveOut: "Leave this scene out", changed: "changed",
    pendingOne: "1 change ready", pendingMany: "changes ready",
    makeChanges: "Make the changes", rebuilding: "Making your new video",
    nothingChanged: "Nothing changed yet", lastTime: "Last time you changed:",
    revert: "Undo this change", done: "Done editing", secondsShort: "s",
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
    edit: "మార్చండి", editTitle: "మీ వీడియో మార్చండి",
    editSub: "ఏ సన్నివేశమైనా చూడండి. ఏమి తప్పు అని చెప్పండి, లేదా కథకుడు చెప్పే మాటలు సరిచేయండి. ఎన్ని అయినా మార్చి, ఒకేసారి చేయించండి.",
    wholeVideo: "పూర్తి వీడియో", theLesson: "చివరిలో నీతి",
    lengthLabel: "ఎంత సేపు", voiceLabel: "ఏ భాష",
    fullLength: "పూర్తి కథ", shortLength: "30 సెకన్లు",
    inTelugu: "తెలుగు", inEnglish: "ఇంగ్లీషు",
    narratorSays: "కథకుడు చెప్పేది", whatsWrongShort: "ఈ సన్నివేశంలో ఏమి తప్పు?",
    leaveOut: "ఈ సన్నివేశం వదిలేయండి", changed: "మార్చారు",
    pendingOne: "1 మార్పు సిద్ధం", pendingMany: "మార్పులు సిద్ధం",
    makeChanges: "మార్పులు చేయండి", rebuilding: "మీ కొత్త వీడియో తయారవుతోంది",
    nothingChanged: "ఇంకా ఏమీ మార్చలేదు", lastTime: "గత సారి మార్చినవి:",
    revert: "ఈ మార్పు రద్దు", done: "మార్చడం పూర్తి", secondsShort: "సె",
    checkScenes: "ఒక్కో సన్నివేశం చూడండి", reviewTitle: "ప్రతి సన్నివేశం ఎలా ఉంది?",
    reviewSub: "ఒక్కొక్కటి చూడండి. ఏదైనా సరిగా లేకపోతే, ఏమి తప్పు అని చెప్పండి, మళ్ళీ చేస్తాను.",
    whatsWrong: "ఈ సన్నివేశంలో ఏమి తప్పు?",
    redoScene: "ఈ సన్నివేశం మళ్ళీ చేయండి", redoing: "ఈ సన్నివేశం మళ్ళీ తయారవుతోంది",
    backToVideo: "వీడియోకు తిరిగి", moralIs: "నీతి", moralComposed: "ఈ కథ కోసం రాసినది",
    moralPrinted: "పుస్తకం నుంచి",
  },
} as const;

/** Choose which cut to watch. Only appears when there IS a choice.
 *
 * Four versions exist for a new film -- Telugu and English, full length and thirty seconds --
 * and that is four buttons too many for someone who just wants to watch her story. So this
 * renders nothing at all unless more than one exists, and a row only appears if that
 * particular choice is available: a story with a Telugu short but no English shows the length
 * row and no language row.
 *
 * Telugu and the full story are the defaults, because that is the film she asked for. The
 * other three are extras.
 */
function VersionPicker({ versions, pick, onPick, labels }: {
  versions: Version[];
  pick: Version;
  onPick: (v: Version) => void;
  labels: Record<string, string>;
}) {
  if (versions.length < 2) return null;
  const has = (length: string, language: string) =>
    versions.find((v) => v.length === length && v.language === language);
  const lengths = Array.from(new Set(versions.map((v) => v.length)));
  const languages = Array.from(new Set(versions.map((v) => v.language)));

  const go = (length: string, language: string) => {
    // Keep the other axis if that combination exists; otherwise move to whatever does, so a
    // button is never dead.
    const exact = has(length, language);
    onPick(exact ?? versions.find((v) => v.length === length)
                 ?? versions.find((v) => v.language === language) ?? versions[0]);
  };

  return (
    <div className="ks-versions">
      {lengths.length > 1 && (
        <div className="ks-vrow" role="group" aria-label={labels.lengthLabel}>
          {lengths.map((len) => (
            <button key={len} type="button"
              className={pick.length === len ? "on" : ""}
              onClick={() => go(len, pick.language)}>
              {len === "full" ? labels.fullLength : labels.shortLength}
            </button>
          ))}
        </div>
      )}
      {languages.length > 1 && (
        <div className="ks-vrow" role="group" aria-label={labels.voiceLabel}>
          {languages.map((lang) => (
            <button key={lang} type="button"
              className={pick.language === lang ? "on" : ""}
              onClick={() => go(pick.length, lang)}>
              {lang === "te" ? labels.inTelugu : labels.inEnglish}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}


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
  const [open, setOpen] = useState<OpenStory | null>(null);
  const [edits, setEdits] = useState<Record<number, PendingEdit>>({});
  const [moralEdit, setMoralEdit] = useState<{ telugu: string; english: string } | null>(null);
  // Which cut she is watching. Reset whenever a different story is opened, so opening an
  // old film does not inherit "English, 30 seconds" from the last one.
  const [watching, setWatching] = useState<Version | null>(null);
  const [versions, setVersions] = useState<Version[]>([]);
  const [rebuilding, setRebuilding] = useState(false);
  // The moment she asked for changes. A rebuild is only finished once final.mp4 is
  // NEWER than this -- otherwise the previous film, still on disk, reads as done.
  const [rebuildFrom, setRebuildFrom] = useState<number | null>(null);
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
    if ((screen !== "making" && screen !== "edit") || !storyDir) return;
    const tick = async () => {
      const got = await fetch(`/api/story/progress?dir=${encodeURIComponent(storyDir)}`)
        .then((r) => r.json()).catch(() => null);
      if (got && !got.error) {
        setProgress(got);
        const fresh = rebuildFrom === null
          ? got.finalReady
          : got.finalReady && (got.finalUpdatedAt ?? 0) > rebuildFrom;
        if (fresh && pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
          setRebuildFrom(null);
          // A finished rebuild means every clip on the editor screen is stale, so reload it.
          if (screen === "edit") { setRebuilding(false); void openForEdit(storyDir, true); }
          // The short and the English cuts are made after the film itself, so ask what
          // exists now rather than assuming.
          void fetch(`/api/story/open?dir=${encodeURIComponent(storyDir)}`)
            .then((r) => r.json())
            .then((o) => { if (o && !o.error) adoptVersions(o.versions ?? []); })
            .catch(() => {});
          void loadPast();
        }
      }
    };
    void tick();
    pollRef.current = setInterval(tick, 5000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [screen, storyDir, loadPast, rebuildFrom]);

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
          advice: Array.isArray(payload.advice) ? payload.advice as string[] : undefined,
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
    // Planning the scenes is when the story finally has a real title, so the folder is
    // renamed to match. Take the new path: the one we sent no longer exists.
    if (got.storyDir) setStoryDir(got.storyDir);
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

  /** Open a finished film for editing. Reads everything off disk, so it works on a story
   *  made in an earlier session -- that is the point of having an Edit button at all. */
  /** Telugu, full length, is what she asked for; everything else is an extra. */
  function adoptVersions(list: Version[]) {
    setVersions(list);
    setWatching(list.find((v) => v.id === "te-full") ?? list[0] ?? null);
  }

  async function openForEdit(dir: string, quiet = false) {
    const got = quiet
      ? await fetch(`/api/story/open?dir=${encodeURIComponent(dir)}`)
          .then((r) => r.json()).catch(() => null)
      : await call<OpenStory>(`/api/story/open?dir=${encodeURIComponent(dir)}`,
          { method: "GET" }, t.edit);
    if (!got || got.error) return;
    setOpen(got);
    setStoryDir(got.storyDir);
    setProgress(got.progress ?? null);
    adoptVersions(got.versions ?? []);
    if (!quiet) {
      setEdits({});
      setMoralEdit(null);
      setScreen("edit");
    }
  }

  function editFor(index: number): PendingEdit {
    return edits[index] ?? { note: "", telugu: "", remove: false };
  }

  function setEdit(index: number, patch: Partial<PendingEdit>) {
    setEdits((prev) => {
      const next = { ...editFor(index), ...patch };
      const untouched = !next.note.trim() && !next.telugu.trim() && !next.remove;
      const out = { ...prev };
      if (untouched) delete out[index];
      else out[index] = next;
      return out;
    });
  }

  /** A scene counts as edited only if she typed something or ticked remove. An untouched
   *  scene is never sent, so it is never re-rendered. */
  const pendingCount = Object.keys(edits).length + (moralEdit ? 1 : 0);

  async function applyEdits() {
    const scenes = Object.entries(edits).map(([index, e]) => ({
      index: Number(index), note: e.note, telugu: e.telugu, remove: e.remove,
    }));
    const got = await call<any>("/api/story/edit",
      { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ storyDir, scenes, moral: moralEdit ?? undefined, aspect }) },
      t.makeChanges);
    if (!got) return;
    setEdits({});
    setMoralEdit(null);
    setRebuildFrom(Date.now());
    setRebuilding(true);
    setProgress(got.progress ?? null);
  }

  function reset() {
    setScreen("home"); setTyped(""); setPhotos([]); setStoryDir(""); setTitle("");
    setStoryText(""); setMoral(""); setFilledIn([]); setNote("");
    setCharacters([]); setScenes([]); setProgress(null); setFailure(null);
    setEdits({}); setOpen(null); setMoralEdit(null); setRebuilding(false);
    setRebuildFrom(null);
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
            {failure.advice && failure.advice.length > 0 && (
              <ul className="ks-error-advice">
                {failure.advice.map((line, n) => <li key={n}>{line}</li>)}
              </ul>
            )}
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
                    <button className="ks-editbtn" onClick={() => openForEdit(s.dir)}>
                      {t.edit}
                    </button>
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
              {watching && (
                <VersionPicker versions={versions} pick={watching}
                  onPick={setWatching} labels={t as unknown as Record<string, string>} />
              )}
              <video className="ks-final" controls autoPlay key={watching?.id ?? "te-full"}
                src={watching?.url
                  ?? `/api/story/file?dir=${encodeURIComponent(storyDir)}&rel=final.mp4`} />
              <div className="ks-nav">
                <a className="ks-go" download
                  href={watching?.url
                    ?? `/api/story/file?dir=${encodeURIComponent(storyDir)}&rel=final.mp4`}>
                  {t.download}
                </a>
                <button className="ks-back" onClick={() => openForEdit(storyDir)}>{t.edit}</button>
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

      {/* -------------------------------------------------- 7. the editor */}
      {screen === "edit" && open && (
        <section className="ks-screen">
          <h1>{t.editTitle}</h1>
          <p className="ks-sub">{t.editSub}</p>

          {rebuilding && (
            <div className="ks-progress ks-rebuild">
              <p className="ks-stage">{t.rebuilding}</p>
              <p className="ks-eta">
                {progress?.label ?? t.working}
                {progress?.minutesLeft != null && ` · about ${progress.minutesLeft} minute${progress.minutesLeft === 1 ? "" : "s"} left`}
              </p>
              <div className="ks-dots">
                {(progress?.scenes ?? []).map((s) => (
                  <span key={s.index} className={s.hasShot ? "done" : ""}>{s.index}</span>
                ))}
              </div>
            </div>
          )}

          {open.finalVideo && !rebuilding && (
            <details className="ks-whole" open>
              <summary>{t.wholeVideo}</summary>
              {watching && (
                <VersionPicker versions={versions} pick={watching}
                  onPick={setWatching} labels={t as unknown as Record<string, string>} />
              )}
              <video className="ks-final" controls preload="metadata"
                key={watching?.id ?? "te-full"} src={watching?.url ?? open.finalVideo} />
            </details>
          )}

          {open.lastApplied.length > 0 && (
            <div className="ks-lastedit">
              <strong>{t.lastTime}</strong>
              <ul>{open.lastApplied.map((a, n) => <li key={n}>{a}</li>)}</ul>
            </div>
          )}

          <ol className="ks-scenes ks-review">
            {open.scenes.map((s) => {
              const e = editFor(s.index);
              const touched = Boolean(edits[s.index]);
              return (
                <li key={s.index} className={touched ? "ks-touched" : ""}>
                  <span className="ks-num">{s.index}</span>
                  <div>
                    <p className="ks-what">
                      {s.summary}
                      {touched && <em className="ks-badge">{t.changed}</em>}
                    </p>
                    {s.video ? (
                      <video className="ks-scene-video" controls preload="metadata"
                        src={s.video} />
                    ) : (
                      <p className="ks-eta">{t.working}</p>
                    )}

                    <label className="ks-flabel" htmlFor={`te-${s.index}`}>
                      {t.narratorSays}
                    </label>
                    <textarea
                      id={`te-${s.index}`}
                      className="ks-te-edit"
                      rows={3}
                      value={e.telugu || s.telugu}
                      onChange={(ev) => setEdit(s.index, {
                        telugu: ev.target.value.trim() === s.telugu.trim()
                          ? "" : ev.target.value,
                      })}
                    />

                    <label className="ks-flabel" htmlFor={`no-${s.index}`}>
                      {t.whatsWrongShort}
                    </label>
                    <input
                      id={`no-${s.index}`}
                      value={e.note}
                      onChange={(ev) => setEdit(s.index, { note: ev.target.value })}
                    />

                    <div className="ks-scenefoot">
                      <label className="ks-check">
                        <input type="checkbox" checked={e.remove}
                          onChange={(ev) => setEdit(s.index, { remove: ev.target.checked })} />
                        {t.leaveOut}
                      </label>
                      {touched && (
                        <button className="ks-undo" onClick={() => setEdit(s.index, { note: "", telugu: "", remove: false })}>
                          {t.revert}
                        </button>
                      )}
                    </div>
                    {s.lastChange && <p className="ks-lastchange">{s.lastChange}</p>}
                  </div>
                  {s.seconds && (
                    <span className="ks-secs">{s.seconds.toFixed(1)}{t.secondsShort}</span>
                  )}
                </li>
              );
            })}
          </ol>

          {open.moral.telugu && (
            <div className="ks-moralbox">
              <h2>{t.theLesson}</h2>
              <textarea
                rows={2}
                className="ks-te-edit"
                value={moralEdit ? moralEdit.telugu : open.moral.telugu}
                onChange={(ev) => setMoralEdit(
                  ev.target.value.trim() === open.moral.telugu.trim()
                    ? null
                    : { telugu: ev.target.value, english: open.moral.english })}
              />
              {open.moral.english && <p className="ks-moral">{open.moral.english}</p>}
            </div>
          )}

          <div className="ks-nav ks-sticky-nav">
            <button className="ks-back" onClick={() => setScreen("home")}>{t.done}</button>
            <span className="ks-pending">{pendingCount === 0 ? t.nothingChanged : pendingCount === 1 ? t.pendingOne : `${pendingCount} ${t.pendingMany}`}</span>
            <button className="ks-go"
              disabled={Boolean(busy) || pendingCount === 0 || rebuilding}
              onClick={applyEdits}>{t.makeChanges}</button>
          </div>
        </section>
      )}

    </main>
  );
}
