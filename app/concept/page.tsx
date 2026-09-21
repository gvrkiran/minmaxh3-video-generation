"use client";

/**
 * Bhavana -- type one concept, or several, and get thirty-second videos with a Telugu
 * voice-over, each in a visual style chosen for it, plus the script of that voice-over to
 * read from if you would rather record it yourself.
 *
 * The third sibling of /garden and /paint, built the same way and for the same reader: linear
 * screens, one decision on each, no seed, no model name, no percentages, waiting described in
 * minutes. Telugu is the default; English is the toggle.
 *
 * ONE BOX, ONE LINE OR MANY. A single line goes through the plan screen -- the model's improved
 * reading of the concept, the look it chose, the lines it will say -- and one tap makes the
 * video. Two or more lines are a list: they are handed to the batch driver and made one after
 * another with nobody asked to approve anything, the way the garden and painting lists are
 * made, and the page follows them on the "being made now" shelf. There is no separate list
 * page; the box is the list.
 *
 * "SURPRISE ME" asks the model for three concepts nobody here has made (`/api/concept/idea`) and
 * drops them into the box as three lines, so what is about to be made is on the screen before
 * anything is spent on it, and one more tap makes all three. If the model cannot be reached the
 * built-in list answers and the page says so.
 *
 * EVERY VIDEO HAS A LOOK. Live action, 3D animation, a 2D cartoon, a watercolour storybook,
 * paper cut-out, clay. The plan writer is nudged toward one drawn at random and keeps it unless
 * the concept plainly wants another; the plan screen names the choice, and so does the finished
 * video's page.
 *
 * The done screen hands back more than the video: every line the voice says, the window of time
 * each has in the finished cut, a text file and a subtitle file of the same, and a cut with no
 * voice on it at all -- because the voice is the one part of a finished reel its owner is
 * likeliest to want to replace with their own.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { surpriseIdeas as localIdeas } from "@/lib/concept-ideas";

type Screen = "type" | "plan" | "making" | "done" | "watch";

type Plan = {
  slug: string;
  titleTe: string;
  titleEn: string;
  understood: string;
  narrationTe: string[];
  narrationEn?: string[];
  style?: string | null;
  styleLabel?: string | null;
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

type ScriptLine = {
  n: number;
  te: string;
  en: string;
  start: number | null;
  end: number | null;
  spoken: { te: number | null; en: number | null };
};

type Script = {
  slug: string;
  titleTe: string;
  titleEn: string;
  typed: string;
  understood: string;
  style: string | null;
  shots: number;
  timed: boolean;
  totalSeconds: number | null;
  lines: ScriptLine[];
  files: { te: string | null; en: string | null; novoice: string | null };
};

type BatchItem = {
  n: number;
  idea: string;
  slug: string;
  status: "pending" | "planning" | "rendering" | "done" | "failed";
  titleTe: string;
  titleEn: string;
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

/** Measured: 4-6 shots at ~4.5 min, plus narration and assembly. Same figure the lists use. */
const MINUTES_PER_REEL = 25;
/** How many ideas one press of "Surprise me" adds to the box. */
const SURPRISE_COUNT = 3;

/** The looks the plan writer can choose, in the reader's language. Keys match `h3_t2v.STYLES`. */
const STYLE_NAMES: Record<string, { te: string; en: string }> = {
  "photoreal": { te: "నిజమైన ఫోటో లాంటి వీడియో", en: "Live-action film" },
  "animation-3d": { te: "3D యానిమేషన్", en: "3D animated film" },
  "cartoon-2d": { te: "2D కార్టూన్", en: "2D cartoon" },
  "storybook": { te: "వాటర్ కలర్ కథల పుస్తకం", en: "Watercolour storybook" },
  "papercraft": { te: "కాగితం కట్-అవుట్ యానిమేషన్", en: "Paper cut-out animation" },
  "claymation": { te: "మట్టి బొమ్మల యానిమేషన్", en: "Clay animation" },
};

const COPY = {
  te: {
    brand: "భావన",
    tagline: "ఒక విషయం చెప్పండి, తెలుగు గొంతుతో చిన్న వీడియో తయారవుతుంది",
    prompt: "వీడియో ఏ విషయం గురించి?",
    help: "ఒక లైనుకు ఒక విషయం — ఏదైనా ఆలోచన, పద్ధతి, ప్రశ్న. ఒక లైను రాస్తే ఒక వీడియో; చాలా లైన్లు రాస్తే అన్నీ ఒకదాని తర్వాత ఒకటి తయారవుతాయి. తెలుగులో, ఇంగ్లీషు అక్షరాలతో తెలుగులో, లేదా ఇంగ్లీషులో రాయండి. ప్రతి వీడియోకి ఒక శైలి — నిజమైన ఫోటో, 3D యానిమేషన్, కార్టూన్, కథల పుస్తకం — దానికదే ఎంచుకుంటుంది.",
    placeholder: "ఉదా:\nవందలో పది రూపాయలు పొదుపు చేయడం\nవర్షాకాలంలో బియ్యం నిల్వ\nఉదయం నడక ఎందుకు",
    surprise: "నన్ను ఆశ్చర్యపరచండి",
    thinking: "కొత్త ఆలోచనలు వెతుకుతున్నాను...",
    offlineIdea: "ఆలోచనల మోడల్ అందలేదు; ఇవి సిద్ధంగా ఉన్న జాబితా నుంచి తీసుకున్నవి.",
    write: "ముందుకు సాగండి",
    writing: "మీ విషయాన్ని చదివి మెరుగుపరుస్తున్నాను...",
    makeMany: "{n} వీడియోలు తయారు చేయండి",
    starting: "జాబితా మొదలుపెడుతున్నాను...",
    estimate: "సుమారు {m} నిమిషాలు",
    estimateHours: "సుమారు {h} గంటలు",
    listStarted: "{n} వీడియోల జాబితా మొదలైంది. కింద “ఇప్పుడు తయారవుతున్నవి”లో చూడండి; తయారైనవి “అన్ని వీడియోలు”లోకి వస్తాయి.",
    listAppended: "నడుస్తున్న జాబితా చివర {n} వీడియోలు చేర్చాను. కింద “ఇప్పుడు తయారవుతున్నవి”లో చూడండి.",
    downloadVideo: "ఈ వీడియో డౌన్‌లోడ్",
    skippedLines: "వాడని లైన్లు:",
    listTitle: "జాబితా",
    listReady: "{d} సిద్ధం",
    listLeft: "{l} మిగిలాయి",
    listFailed: "{f} విఫలం",
    stop: "ఆపు",
    retry: "మిగిలినవి మళ్ళీ ప్రయత్నించండి",
    planTitle: "ఇలా చేద్దామా?",
    understood: "నేను అర్థం చేసుకున్నది, ఎంచుకున్న కోణం",
    styleLabel: "శైలి",
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
    library: "అన్ని వీడియోలు",
    mine: "నేను చేసినవి",
    empty: "ఇంకా వీడియోలు లేవు. మొదటిది మీరే చేయండి.",
    back: "వెనక్కి",
    newVideo: "కొత్త వీడియో",
    scriptTitle: "గొంతు కోసం చదవాల్సిన వాక్యాలు",
    scriptHelp: "ప్రతి వాక్యం ఒక షాట్ మీద చెప్పబడుతుంది. మీ గొంతుతో మళ్ళీ రికార్డు చేయాలంటే, ఇక్కడ చూపిన సమయంలోపు ఆ వాక్యం చదవండి. బ్రాకెట్‌లో ఉన్నది యంత్రం గొంతు తీసుకున్న సమయం.",
    scriptLoading: "వాక్యాలు, సమయాలు సిద్ధం చేస్తున్నాను...",
    scriptUnavailable: "వాక్యాలు చదవలేకపోయాను.",
    voiceTook: "గొంతు",
    seconds: "సె",
    downloadTxt: "వాక్యాలు డౌన్‌లోడ్ (టెక్స్ట్ ఫైల్)",
    downloadSrt: "సబ్‌టైటిల్స్ డౌన్‌లోడ్ (.srt)",
    downloadNoVoice: "గొంతు లేని వీడియో (మీ రికార్డింగ్ కోసం)",
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
    brand: "Bhavana",
    tagline: "Tell it one concept, get a short video with a Telugu voice-over",
    prompt: "What should the video be about?",
    help: "One concept per line -- a thing, an idea, a practice, a question. One line makes one video; several lines are made one after another. Telugu, Telugu in English letters, or English. Each video picks its own look: live action, 3D animation, a cartoon, a storybook, paper or clay.",
    placeholder: "e.g.\nsaving ten rupees from every hundred\nstoring rice through the monsoon\nwhy a morning walk",
    surprise: "Surprise me",
    thinking: "Thinking of some...",
    offlineIdea: "The idea model could not be reached, so these are from the built-in list.",
    write: "Carry on",
    writing: "Reading and improving your concept...",
    makeMany: "Make {n} videos",
    starting: "Starting the list...",
    estimate: "about {m} minutes",
    estimateHours: "about {h} hours",
    listStarted: "A list of {n} videos has started. Follow it under “Being made now”; finished ones appear under “All videos”.",
    listAppended: "Added {n} videos to the end of the list being made. Follow them under “Being made now”.",
    downloadVideo: "Download this video",
    skippedLines: "Lines not used:",
    listTitle: "List",
    listReady: "{d} ready",
    listLeft: "{l} to go",
    listFailed: "{f} failed",
    stop: "Stop",
    retry: "Retry the unfinished ones",
    planTitle: "Shall we do this?",
    understood: "What I understood, and the angle",
    styleLabel: "Look",
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
    library: "All videos",
    mine: "Made here",
    empty: "No videos yet. Make the first one.",
    back: "Back",
    newVideo: "New video",
    scriptTitle: "Voice-over script",
    scriptHelp: "Each line is spoken over one shot. To record it in your own voice, read each line inside the window shown. The figure in brackets is how long the machine's voice took.",
    scriptLoading: "Preparing the lines and their timings...",
    scriptUnavailable: "The script could not be read.",
    voiceTook: "voice",
    seconds: "s",
    downloadTxt: "Download the script (text file)",
    downloadSrt: "Download subtitles (.srt)",
    downloadNoVoice: "Video without the voice (for your own recording)",
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

/** `0:06.6` -- what a person reads off while recording. */
function clock(seconds: number): string {
  const whole = Math.floor(seconds);
  const tenths = Math.min(9, Math.round((seconds - whole) * 10));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}.${tenths}`;
}

/**
 * The usable lines in the box, counted the way the server counts them: blank lines and `#`
 * comments dropped, repeats dropped, anything under three letters dropped.
 */
function ideaLines(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.length < 3) continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  return out;
}

export default function Concept() {
  const [lang, setLang] = useState<"te" | "en">("te");
  const [screen, setScreen] = useState<Screen>("type");
  const [concept, setConcept] = useState("");
  const [busy, setBusy] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [library, setLibrary] = useState<LibraryItem[]>([]);
  const [active, setActive] = useState<Active[]>([]);
  const [batch, setBatch] = useState<Batch | null>(null);
  const [watching, setWatching] = useState<LibraryItem | null>(null);
  const [script, setScript] = useState<Script | null>(null);
  const [scriptBusy, setScriptBusy] = useState(false);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);
  // Ideas already offered in this sitting, so pressing the button twice never brings one back.
  const shown = useRef<string[]>([]);

  const t = COPY[lang];

  const loadLibrary = useCallback(async () => {
    try {
      const got = await fetch("/api/concept/library", { cache: "no-store" });
      const data = await got.json() as { items?: LibraryItem[] };
      setLibrary(data.items ?? []);
    } catch { /* the shelf is not worth an error banner; the next visit will fill it */ }
  }, []);

  const loadActive = useCallback(async () => {
    try {
      const got = await fetch("/api/concept/active", { cache: "no-store" });
      const data = await got.json() as { items?: Active[] };
      setActive(data.items ?? []);
    } catch { /* same: a dropped poll is not worth a banner */ }
  }, []);

  /**
   * The list worth showing: the one being made, or else the newest one with something left
   * unfinished, so a stopped or half-failed list can be carried on from here. A list that is
   * entirely done has nothing to say -- its videos are on the shelf.
   */
  const loadBatch = useCallback(async () => {
    try {
      const got = await fetch("/api/concept/batch", { cache: "no-store" });
      const data = await got.json() as { batches?: Batch[] };
      const all = data.batches ?? [];
      setBatch(all.find((b) => b.live)
        ?? all.find((b) => b.counts.done < b.counts.total) ?? null);
    } catch { /* same */ }
  }, []);

  /**
   * The lines, their windows and the files that exist. The first call for a finished reel
   * also makes the no-voice cut on the server, which is a few seconds of ffmpeg -- hence the
   * "preparing" line rather than an empty space.
   */
  const loadScript = useCallback(async (slug: string) => {
    setScript(null);
    setScriptBusy(true);
    try {
      const got = await fetch(`/api/concept/script?slug=${encodeURIComponent(slug)}`,
        { cache: "no-store" });
      if (got.ok) setScript(await got.json() as Script);
    } catch { /* the panel says it could not be read */ } finally {
      setScriptBusy(false);
    }
  }, []);

  useEffect(() => { void loadLibrary(); }, [loadLibrary]);

  // What is being made refreshes every 10s while the home screen is open. Slower than the
  // making screen's 5s, because this is a glance, not a wait, and the machine behind it is
  // busy with a graphics card job. Torn down the moment she leaves the home screen.
  const onHome = screen === "type" || screen === "done";
  useEffect(() => {
    if (!onHome) return;
    void loadActive();
    void loadBatch();
    const timer = setInterval(() => { void loadActive(); void loadBatch(); }, 10_000);
    return () => clearInterval(timer);
  }, [onHome, loadActive, loadBatch]);

  const stopPolling = useCallback(() => {
    if (poll.current) { clearInterval(poll.current); poll.current = null; }
  }, []);

  // Poll while the render runs. Every 5s: a shot takes minutes, so anything faster is just
  // load on a machine that is busy with a graphics card job.
  const startPolling = useCallback((slug: string) => {
    stopPolling();
    const tick = async () => {
      try {
        const got = await fetch(`/api/concept/progress?slug=${encodeURIComponent(slug)}`,
          { cache: "no-store" });
        const next = await got.json() as Progress;
        setProgress(next);
        if (next.ready) {
          stopPolling();
          setScreen("done");
          void loadLibrary();      // it belongs on the shelf the moment it exists
          void loadScript(slug);   // and its script beside it
        } else if (next.stage === "failed") {
          stopPolling();
          setProblem(next.failed ?? null);
        }
      } catch { /* a dropped poll is not worth showing her; the next one will land */ }
    };
    void tick();
    poll.current = setInterval(tick, 5000);
  }, [stopPolling, loadLibrary, loadScript]);

  useEffect(() => stopPolling, [stopPolling]);

  const lines = ideaLines(concept);

  /** One line: the plan screen. */
  async function writePlan() {
    setBusy(true);
    setProblem(null);
    setNotice(null);
    try {
      const got = await fetch("/api/concept/plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ concept: lines[0] ?? concept }),
      });
      const data = await got.json();
      if (!got.ok) throw new Error(data.error ?? "Could not plan the video.");
      setPlan(data.plan as Plan);
      setScreen("plan");
    } catch (caught) {
      setProblem(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Several lines: a list, made without an approval step. The box is emptied once the driver
   * has taken the lines, and the shelf below shows them being made.
   */
  async function startList() {
    setBusy(true);
    setProblem(null);
    setNotice(null);
    setSkipped([]);
    try {
      const got = await fetch("/api/concept/batch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ideas: concept }),
      });
      const data = await got.json() as {
        error?: string; skipped?: string[]; appended?: number; batch?: Batch;
      };
      if (!got.ok) throw new Error(data.error ?? "Could not start the list.");
      setSkipped(data.skipped ?? []);
      // Joined a running list, or started one: the same button, and the note says which.
      setNotice(data.appended
        ? t.listAppended.replace("{n}", String(data.appended))
        : t.listStarted.replace("{n}", String(data.batch?.counts.total ?? lines.length)));
      setConcept("");
      if (data.batch) setBatch(data.batch);
      void loadActive();
    } catch (caught) {
      setProblem(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Ask the model for a few concepts nobody here has made, and add them to the box as lines.
   * The server already knows every reel and list on disk; what only this page knows is what it
   * has offered before and what is in the box now, so those go along as things to avoid.
   */
  async function surprise() {
    setThinking(true);
    setProblem(null);
    setNotice(null);
    let ideas: string[] = [];
    let fromList = false;
    try {
      const got = await fetch("/api/concept/idea", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          count: SURPRISE_COUNT, lang,
          avoid: [...shown.current, ...lines].filter(Boolean),
        }),
      });
      const data = await got.json() as { ideas?: string[]; source?: string };
      ideas = (data.ideas ?? []).map((s) => s.trim()).filter(Boolean);
      fromList = data.source === "local";
      if (!got.ok || !ideas.length) throw new Error("No idea came back.");
    } catch {
      // Last resort, and said out loud: the built-in list, never a button that does nothing.
      ideas = localIdeas(SURPRISE_COUNT, lang);
      fromList = true;
    } finally {
      setThinking(false);
    }
    shown.current.push(...ideas);
    // Appended, not replaced: what she typed stays, and the ideas become lines beneath it.
    setConcept((was) => [was.trimEnd(), ...ideas].filter(Boolean).join("\n"));
    if (fromList) setNotice(t.offlineIdea);
  }

  async function makeVideo() {
    if (!plan) return;
    setBusy(true);
    setProblem(null);
    try {
      const got = await fetch("/api/concept/render", {
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

  /** Stop the running list, or gather everything unfinished into a new one. */
  async function controlList(action: "stop" | "retry-all") {
    if (!batch) return;
    setBusy(true);
    setProblem(null);
    try {
      const got = await fetch("/api/concept/control", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: batch.id, action }),
      });
      const data = await got.json() as { error?: string; batch?: Batch };
      if (!got.ok) throw new Error(data.error ?? "That did not work.");
      if (data.batch) setBatch(data.batch);
      void loadActive();
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
        const got = await fetch("/api/concept/render", {
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
    setPlan(null); setProgress(null); setProblem(null); setNotice(null); setConcept("");
    setWatching(null); setScript(null); setSkipped([]);
    setScreen("type");
    void loadLibrary();
  }

  function watch(item: LibraryItem) {
    setWatching(item);
    setScreen("watch");
    void loadScript(item.slug);
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

  /** A look's name in the reader's language, or the plan writer's own label if it is new. */
  function styleName(key: string | null | undefined, fallback?: string | null): string | null {
    if (!key) return null;
    return STYLE_NAMES[key]?.[lang] ?? fallback ?? key;
  }

  /** The finished cut to play for a slug: the toggle's language where that cut exists. */
  function cutName(slug: string, languages: Array<"te" | "en">): string {
    return `${slug}_${languages.includes(lang) ? lang : "te"}.mp4`;
  }

  function cutFor(slug: string, languages: Array<"te" | "en">): string {
    return `/api/concept/file?slug=${encodeURIComponent(slug)}&rel=${encodeURIComponent(cutName(slug, languages))}`;
  }

  /**
   * The video itself, to keep. Same file the player is showing -- with the voice on it -- so
   * what is downloaded is what was watched. The `download` name matters: the file route's
   * URL ends in a query string, and without it the browser would save "file" with no
   * extension.
   */
  function VideoDownload({ slug, languages }: { slug: string; languages: Array<"te" | "en"> }) {
    return (
      <a style={S.downloadVideo} href={cutFor(slug, languages)} download={cutName(slug, languages)}>
        {t.downloadVideo}
      </a>
    );
  }

  /** "about 75 minutes" or "about 2.5 hours", for the button under a list. */
  function estimate(count: number): string {
    const minutes = count * MINUTES_PER_REEL;
    if (minutes < 90) return t.estimate.replace("{m}", String(minutes));
    return t.estimateHours.replace("{h}", String(Math.round((minutes / 60) * 10) / 10));
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

  /**
   * The list being made, in one line: how many are ready, how many to go, how long, and a
   * button to stop it -- or, for a list that stopped or lost some, a button to carry on. The
   * items themselves are on the shelf above as they are made; only the ones that failed
   * before they had a folder are named here, with what went wrong.
   */
  function ListBanner() {
    if (!batch) return null;
    const c = batch.counts;
    const left = c.total - c.done - c.failed;
    const failed = batch.items.filter((i) => i.status === "failed");
    return (
      <section style={S.banner}>
        <div style={S.bannerRow}>
          <div>
            <span style={S.bannerTitle}>{t.listTitle} · {c.total}</span>
            <span style={S.bannerCounts}>
              {" "}{t.listReady.replace("{d}", String(c.done))}
              {left > 0 && ` · ${t.listLeft.replace("{l}", String(left))}`}
              {c.failed > 0 && ` · ${t.listFailed.replace("{f}", String(c.failed))}`}
              {batch.live && batch.minutesLeft !== null && ` · ${batch.minutesLeft} ${t.minutes}`}
            </span>
          </div>
          {batch.live ? (
            <button style={{ ...S.smallButton, ...(busy ? S.disabled : {}) }} disabled={busy}
              onClick={() => void controlList("stop")}>{t.stop}</button>
          ) : c.done < c.total ? (
            <button style={{ ...S.smallButton, ...(busy ? S.disabled : {}) }} disabled={busy}
              onClick={() => void controlList("retry-all")}>{t.retry}</button>
          ) : null}
        </div>
        {failed.map((item) => (
          <div key={item.slug} style={S.bannerFailed}>
            <span>{item.idea}</span>
            {item.error && <span style={S.bannerError}> — {item.error.slice(-160)}</span>}
          </div>
        ))}
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
              src={`/api/concept/file?slug=${encodeURIComponent(item.slug)}&rel=poster.jpg`}
            />
          ) : <div style={{ ...S.thumb, background: "#d6e0e4" }} />}
          {item.seconds !== null && (
            <span style={S.badge}>{Math.round(item.seconds)}s</span>
          )}
        </div>
        <div style={S.cardTitle}>{title}</div>
      </button>
    );
  }

  /**
   * The voice-over script under a finished video: every line with its window, in the toggle's
   * language first and the other beneath, then the three things to take away -- the text
   * file, the subtitle file, and the cut with no voice on it.
   */
  function ScriptPanel({ slug }: { slug: string }) {
    if (scriptBusy) return <p style={S.help}>{t.scriptLoading}</p>;
    if (!script || script.slug !== slug) return <p style={S.help}>{t.scriptUnavailable}</p>;
    const other = lang === "te" ? "en" : "te";
    const enc = encodeURIComponent(slug);
    return (
      <section style={S.scriptBox}>
        <div style={S.label}>{t.scriptTitle}</div>
        <p style={S.help}>{t.scriptHelp}</p>
        <ol style={S.cues}>
          {script.lines.map((line) => (
            <li key={line.n} style={S.cue}>
              {line.start !== null && line.end !== null && (
                <div style={S.cueTime}>
                  {clock(line.start)} – {clock(line.end)}
                  {line.spoken[lang] !== null && (
                    <span style={S.cueSpoken}>
                      {" "}({t.voiceTook} {line.spoken[lang]!.toFixed(1)} {t.seconds})
                    </span>
                  )}
                </div>
              )}
              <div style={S.cueMain}>{line[lang]}</div>
              {line[other] && <div style={S.cueOther}>{line[other]}</div>}
            </li>
          ))}
        </ol>
        <div style={S.downloads}>
          <a style={S.download} href={`/api/concept/script?slug=${enc}&format=txt`} download>
            {t.downloadTxt}
          </a>
          {script.timed && (
            <a style={S.download} href={`/api/concept/script?slug=${enc}&format=srt&lang=${lang}`} download>
              {t.downloadSrt}
            </a>
          )}
          {script.files.novoice && (
            <a
              style={S.download}
              href={`/api/concept/file?slug=${enc}&rel=${encodeURIComponent(script.files.novoice)}`}
              download
            >
              {t.downloadNoVoice}
            </a>
          )}
        </div>
      </section>
    );
  }

  const planLines = plan
    ? (lang === "en" && plan.narrationEn?.length ? plan.narrationEn : plan.narrationTe)
    : [];
  const many = lines.length >= 2;
  const mainLabel = busy
    ? (many ? t.starting : t.writing)
    : many ? t.makeMany.replace("{n}", String(lines.length)) : t.write;

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

      {notice && (
        <div style={S.notice}>
          {notice}
          {skipped.length > 0 && (
            <div style={S.noticeSub}>{t.skippedLines} {skipped.join(" · ")}</div>
          )}
        </div>
      )}

      {screen === "type" && (
        <section style={S.card}>
          <h1 style={S.h1}>{t.prompt}</h1>
          <p style={S.help}>{t.help}</p>
          <textarea
            style={S.textarea}
            value={concept}
            onChange={(e) => setConcept(e.target.value)}
            placeholder={t.placeholder}
            rows={6}
            autoFocus
          />
          <button
            style={{ ...S.primary, ...(busy || thinking || !lines.length ? S.disabled : {}) }}
            disabled={busy || thinking || !lines.length}
            onClick={() => void (many ? startList() : writePlan())}
          >
            {mainLabel}
          </button>
          {/* The bill, stated before the button is pressed: a list is minutes of graphics card
              per line, and a typo in a paste should not become an afternoon by surprise. */}
          {many && !busy && <div style={S.estimate}>{estimate(lines.length)}</div>}
          {/* Fills the box rather than starting: what is about to be made stays on screen,
              and she can change or delete a line before spending on it. */}
          <button
            style={{ ...S.secondary, ...(busy || thinking ? S.disabled : {}) }}
            disabled={busy || thinking}
            onClick={() => void surprise()}
          >
            {thinking ? t.thinking : t.surprise}
          </button>
        </section>
      )}

      {screen === "type" && <ListBanner />}
      {screen === "type" && <Active />}

      {screen === "type" && (
        <section style={S.shelf}>
          <h2 style={S.h2}>{t.library}</h2>
          <Shelf />
        </section>
      )}

      {screen === "watch" && watching && (
        <section style={S.card}>
          <button style={S.back} onClick={() => { setWatching(null); setScript(null); setScreen("type"); }}>
            &larr; {t.back}
          </button>
          <h1 style={S.h1}>
            {lang === "te" ? (watching.titleTe || watching.titleEn) : (watching.titleEn || watching.titleTe)}
          </h1>
          {script?.style && (
            <div style={S.styleTag}>{t.styleLabel}: {styleName(script.style)}</div>
          )}
          <video
            key={`${watching.slug}-${lang}`}
            style={S.video}
            controls
            autoPlay
            playsInline
            poster={watching.poster
              ? `/api/concept/file?slug=${encodeURIComponent(watching.slug)}&rel=poster.jpg`
              : undefined}
            src={cutFor(watching.slug, watching.languages)}
          />
          <VideoDownload slug={watching.slug} languages={watching.languages} />
          <ScriptPanel slug={watching.slug} />
          <button style={S.primary} onClick={startOver}>{t.newVideo}</button>
        </section>
      )}

      {screen === "plan" && plan && (
        <section style={S.card}>
          <h1 style={S.h1}>{t.planTitle}</h1>
          <div style={S.planTitle}>{lang === "te" ? plan.titleTe : plan.titleEn}</div>

          {/* The improved concept comes first: it is the one place the model was allowed to
              change what was asked for, and the thing to check before spending on it. */}
          <div style={S.label}>{t.understood}</div>
          <p style={S.understood}>{plan.understood}</p>

          {plan.style && (
            <>
              <div style={S.label}>{t.styleLabel}</div>
              <p style={S.understood}>{styleName(plan.style, plan.styleLabel)}</p>
            </>
          )}

          <div style={S.label}>{t.willSay}</div>
          <ol style={S.lines}>
            {planLines.map((line, i) => (
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
          {script?.style && (
            <div style={S.styleTag}>{t.styleLabel}: {styleName(script.style)}</div>
          )}
          <video
            key={`${progress.slug}-${lang}`}
            style={S.video}
            controls
            playsInline
            src={cutFor(progress.slug, script?.files.en ? ["te", "en"] : ["te"])}
          />
          <VideoDownload slug={progress.slug} languages={script?.files.en ? ["te", "en"] : ["te"]} />
          <ScriptPanel slug={progress.slug} />
          <button style={S.primary} onClick={startOver}>{t.makeAnother}</button>
        </section>
      )}

      {screen === "done" && <ListBanner />}
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

/* Inline styles, matching /garden and /paint -- this app ships no CSS framework, and a
   stylesheet for one page would be a second place to look. Same bones as the other two, in a
   deep teal rather than leaf green or madder red, so the three are never mistaken for each
   other on a phone. */
const ACCENT = "#1e5a6e";
const S: Record<string, React.CSSProperties> = {
  page: {
    minHeight: "100vh", background: "#f3f5f4", color: "#1f2426",
    fontFamily: "system-ui, 'Noto Sans Telugu', sans-serif",
    padding: "20px 16px 64px", maxWidth: 680, margin: "0 auto",
  },
  header: {
    display: "flex", justifyContent: "space-between", alignItems: "flex-start",
    gap: 12, marginBottom: 24,
  },
  brand: { fontSize: 30, fontWeight: 700, color: ACCENT, lineHeight: 1.2 },
  tagline: { fontSize: 15, color: "#5f6a6e", marginTop: 4 },
  langButton: {
    background: "none", border: "1.5px solid #bfc9cc", borderRadius: 999,
    padding: "8px 16px", fontSize: 15, color: "#4a565b", cursor: "pointer",
    flexShrink: 0, fontFamily: "inherit",
  },
  card: {
    background: "#fff", borderRadius: 18, padding: "24px 20px",
    boxShadow: "0 2px 14px rgba(30,60,70,0.08)",
  },
  h1: { fontSize: 23, fontWeight: 700, margin: "0 0 8px", lineHeight: 1.35 },
  help: { fontSize: 15, color: "#5f6a6e", margin: "0 0 16px", lineHeight: 1.6 },
  textarea: {
    width: "100%", boxSizing: "border-box", fontSize: 18, lineHeight: 1.7,
    padding: 14, borderRadius: 12, border: "1.5px solid #cfd8db",
    fontFamily: "inherit", resize: "vertical", background: "#fafcfc",
  },
  primary: {
    width: "100%", marginTop: 18, padding: "16px 20px", fontSize: 19, fontWeight: 600,
    color: "#fff", background: ACCENT, border: "none", borderRadius: 12,
    cursor: "pointer", fontFamily: "inherit",
  },
  secondary: {
    width: "100%", marginTop: 10, padding: "13px 20px", fontSize: 16,
    color: "#5f6a6e", background: "none", border: "none", cursor: "pointer",
    fontFamily: "inherit", textDecoration: "underline",
  },
  smallButton: {
    padding: "8px 14px", fontSize: 14, fontWeight: 600, color: ACCENT,
    background: "#fff", border: `1.5px solid ${ACCENT}`, borderRadius: 999,
    cursor: "pointer", fontFamily: "inherit", flexShrink: 0,
  },
  disabled: { opacity: 0.45, cursor: "default" },
  estimate: { textAlign: "center", fontSize: 14, color: "#5f6a6e", marginTop: 8 },
  planTitle: { fontSize: 21, fontWeight: 700, color: ACCENT, margin: "4px 0 18px" },
  styleTag: {
    display: "inline-block", fontSize: 13, color: ACCENT, background: "#e4edf0",
    borderRadius: 999, padding: "4px 12px", margin: "-8px 0 14px",
  },
  label: {
    fontSize: 13, textTransform: "uppercase", letterSpacing: 0.7,
    color: "#7d8a8f", marginTop: 16, marginBottom: 6,
  },
  understood: { fontSize: 16, lineHeight: 1.6, margin: 0, color: "#3d4649" },
  lines: { margin: "0", paddingLeft: 22 },
  line: { fontSize: 18, lineHeight: 1.85, marginBottom: 8 },
  stage: { fontSize: 18, marginTop: 8 },
  minutes: { fontSize: 40, fontWeight: 700, color: ACCENT, margin: "10px 0 4px" },
  track: {
    height: 10, background: "#e2e8ea", borderRadius: 999, overflow: "hidden",
    margin: "14px 0 18px",
  },
  trackSmall: {
    height: 6, background: "#e2e8ea", borderRadius: 999, overflow: "hidden",
    margin: "8px 0 6px",
  },
  fill: { height: "100%", background: ACCENT, transition: "width 400ms ease" },
  video: {
    width: "100%", borderRadius: 14, background: "#000", marginTop: 6,
    aspectRatio: "9 / 16", objectFit: "contain",
  },
  // The script sits in its own tinted box under the video, so the lines read as a thing to
  // take away rather than as more page.
  scriptBox: {
    background: "#eef3f4", borderRadius: 14, padding: "6px 16px 16px", marginTop: 18,
  },
  cues: { margin: 0, paddingLeft: 22 },
  cue: { marginBottom: 14, lineHeight: 1.5 },
  cueTime: {
    fontSize: 13, color: ACCENT, fontWeight: 600, letterSpacing: 0.3,
    fontVariantNumeric: "tabular-nums",
  },
  cueSpoken: { color: "#7d8a8f", fontWeight: 400 },
  cueMain: { fontSize: 18, lineHeight: 1.8, marginTop: 2 },
  cueOther: { fontSize: 14, color: "#5f6a6e", lineHeight: 1.5, marginTop: 2 },
  downloads: { display: "flex", flexDirection: "column", gap: 8, marginTop: 10 },
  download: {
    display: "block", padding: "12px 14px", background: "#fff", borderRadius: 10,
    color: ACCENT, fontWeight: 600, fontSize: 15, textDecoration: "none",
    border: "1.5px solid #cfd8db",
  },
  // Directly under the player, filled rather than outlined: it is the one download most
  // people want, and it should not have to be found among the script's three.
  downloadVideo: {
    display: "block", marginTop: 12, padding: "13px 16px", textAlign: "center",
    background: "#e4edf0", color: ACCENT, fontWeight: 600, fontSize: 16,
    borderRadius: 12, textDecoration: "none",
  },
  // The list line: one row, counts on the left, the one button on the right.
  banner: {
    background: "#fff", borderRadius: 14, padding: "12px 16px", marginTop: 18,
    boxShadow: "0 2px 10px rgba(30,60,70,0.08)",
  },
  bannerRow: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 },
  bannerTitle: { fontSize: 15, fontWeight: 700, color: "#33403f" },
  bannerCounts: { fontSize: 14, color: "#5f6a6e" },
  bannerFailed: { fontSize: 13, color: "#8f403a", marginTop: 8, lineHeight: 1.5 },
  bannerError: { color: "#7d8a8f" },
  shelf: { marginTop: 26 },
  h2: { fontSize: 18, fontWeight: 700, margin: "0 0 6px", color: "#33403f" },
  shelfLabel: {
    fontSize: 13, textTransform: "uppercase", letterSpacing: 0.7,
    color: "#7d8a8f", margin: "16px 0 8px",
  },
  activeList: { display: "flex", flexDirection: "column", gap: 10, marginTop: 8 },
  // A row, not a poster card: there is no picture yet, and the words are the point.
  activeRow: {
    background: "#fff", border: "none", borderRadius: 14, padding: "14px 16px",
    textAlign: "left", cursor: "pointer", fontFamily: "inherit", width: "100%",
    boxShadow: "0 2px 10px rgba(30,60,70,0.08)", color: "#1f2426",
  },
  activeTitle: { fontSize: 17, fontWeight: 600, lineHeight: 1.4 },
  activeStage: { fontSize: 15, color: ACCENT, marginTop: 4 },
  activeStalled: { color: "#8f403a" },
  activeHint: { fontSize: 13, color: "#7d8a8f", marginTop: 4 },
  // Two columns on a phone, more when there is room. auto-fill rather than a fixed count so
  // the same grid works on her phone and on a laptop with no media query.
  grid: {
    display: "grid", gap: 12,
    gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))",
  },
  card2: {
    background: "#fff", border: "none", borderRadius: 14, padding: 0,
    overflow: "hidden", cursor: "pointer", textAlign: "left",
    boxShadow: "0 2px 10px rgba(30,60,70,0.08)", fontFamily: "inherit",
  },
  thumbWrap: { position: "relative", lineHeight: 0 },
  // 9:16 posters, so a card is tall like the video it opens.
  thumb: { width: "100%", aspectRatio: "9 / 16", objectFit: "cover", display: "block" },
  badge: {
    position: "absolute", right: 6, bottom: 6, background: "rgba(0,0,0,0.66)",
    color: "#fff", fontSize: 12, padding: "2px 7px", borderRadius: 999,
  },
  cardTitle: {
    fontSize: 14, lineHeight: 1.45, padding: "9px 10px 11px", color: "#2b3335",
  },
  back: {
    background: "none", border: "none", padding: 0, marginBottom: 10,
    fontSize: 15, color: "#5f6a6e", cursor: "pointer", fontFamily: "inherit",
  },
  problem: {
    background: "#fdeceb", border: "1.5px solid #e8b7b3", borderRadius: 12,
    padding: "14px 16px", marginBottom: 18, fontSize: 15, lineHeight: 1.6,
  },
  problemText: { marginTop: 6, color: "#7a3b36", wordBreak: "break-word" },
  // A note, not a problem: the list started, or the ideas came from the built-in list.
  notice: {
    background: "#e4edf0", border: "1.5px solid #bfd3da", borderRadius: 12,
    padding: "12px 16px", marginBottom: 18, fontSize: 15, lineHeight: 1.6, color: "#2b4a55",
  },
  noticeSub: { marginTop: 6, fontSize: 14, color: "#5f6a6e" },
};
