"use client";

import { ChangeEvent, DragEvent, useCallback, useEffect, useState } from "react";

type Mode = "t2v" | "i2v" | "r2v";
type CharacterProfile = {
  id: string;
  name: string;
  description: string;
  filename: string;
  createdAt: number;
};
type NarrationSegment = {
  speaker: string;
  voice: "male" | "female";
  language: string;
  startSeconds: number;
  endSeconds: number;
  text: string;
};
type MachineStatus = {
  online: boolean;
  queueRunning: number;
  queuePending: number;
  gpu?: string;
  vramFreeGb?: number;
  version?: string;
  narrationOnline?: boolean;
  narrationActive?: boolean;
  narrationError?: string;
  geminiConfigured?: boolean;
  r2vModelReady?: boolean;
};
type HistoryItem = {
  id: string;
  mode: Mode;
  prompt: string;
  originalPrompt?: string;
  enhancedPrompt?: string;
  promptEnhanced?: boolean;
  filename: string;
  narratedFilename?: string;
  narrationRequested?: boolean;
  subfolder: string;
  createdAt?: number;
  speakerPlan?: NarrationSegment[];
};
type QueueJob = {
  id: string;
  state: "running" | "pending";
  position: number;
  mode: Mode;
  prompt: string;
  width: number;
  height: number;
  duration: number;
  steps: number;
  seed: number;
  narration?: boolean;
  createdAt?: number;
  speakerPlan?: NarrationSegment[];
};

type EnhancementPayload = {
  error?: string;
  videoPrompt?: string;
  narrationText?: string;
  narrationSegments?: NarrationSegment[];
  narrationMode?: "none" | "single" | "dialogue";
  narrationLanguage?: string;
  narrationSupported?: boolean;
};

async function readJsonResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    const details = text.trim();
    const suffix = details && details !== "Internal Server Error" ? `: ${details.slice(0, 180)}` : ".";
    throw new Error(response.ok
      ? "The studio returned an unreadable response. Refresh the page and retry."
      : `The studio server failed (${response.status})${suffix}`);
  }
}

const ASPECTS = [
  { value: "16:9", label: "Landscape", shape: "▭" },
  { value: "9:16", label: "Portrait", shape: "▯" },
  { value: "1:1", label: "Square", shape: "□" },
  { value: "4:3", label: "Classic", shape: "▭" },
];

const QUALITIES = [
  { value: "0.2", label: "Draft", detail: "Fast" },
  { value: "0.4", label: "Balanced", detail: "Recommended" },
  { value: "0.6", label: "Detail", detail: "Sharper" },
  { value: "0.98", label: "Native", detail: "Maximum" },
];

const DEFAULT_PROMPT =
  "A cinematic street scene in Hyderabad at golden hour. A young Indian man walks naturally past colorful market stalls and auto-rickshaws near the Charminar. The camera tracks beside him with gentle handheld movement. Natural footsteps, distant traffic, and lively street ambience. No text, logos, or watermarks.";

function castBoardPosition(index: number, count: number) {
  if (count === 2) return index === 0 ? "left" : "right";
  if (count === 3) return ["left", "center", "right"][index] ?? "right";
  const columns = count === 4 ? 2 : 3;
  const rowNames = count === 4 ? ["top", "bottom"] : ["top", "middle", "bottom"];
  const columnNames = columns === 2 ? ["left", "right"] : ["left", "center", "right"];
  return `${rowNames[Math.floor(index / columns)] ?? "bottom"} ${columnNames[index % columns] ?? "right"}`;
}

export default function Home() {
  const [mode, setMode] = useState<Mode>("t2v");
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [aspect, setAspect] = useState("16:9");
  const [quality, setQuality] = useState("0.4");
  const [duration, setDuration] = useState(5);
  const [steps, setSteps] = useState(20);
  const [seed, setSeed] = useState(() => Math.floor(Math.random() * 999_999_999));
  const [narrationEnabled, setNarrationEnabled] = useState(false);
  const [narrationText, setNarrationText] = useState("");
  const [narrationSegments, setNarrationSegments] = useState<NarrationSegment[]>([]);
  const [narrationVoice, setNarrationVoice] = useState("female");
  const [voiceFile, setVoiceFile] = useState<File | null>(null);
  const [voiceTranscript, setVoiceTranscript] = useState("");
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [characters, setCharacters] = useState<CharacterProfile[]>([]);
  const [selectedCharacterIds, setSelectedCharacterIds] = useState<string[]>([]);
  const [characterName, setCharacterName] = useState("");
  const [characterDescription, setCharacterDescription] = useState("");
  const [characterFile, setCharacterFile] = useState<File | null>(null);
  const [savingCharacter, setSavingCharacter] = useState(false);
  const [referenceFidelity, setReferenceFidelity] = useState<"match" | "max">("max");
  const [status, setStatus] = useState<MachineStatus>({ online: false, queueRunning: 0, queuePending: 0 });
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [queueJobs, setQueueJobs] = useState<QueueJob[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [submissionPhase, setSubmissionPhase] = useState<"idle" | "enhancing" | "queueing">("idle");
  const [autoEnhance, setAutoEnhance] = useState(true);
  const [queueAction, setQueueAction] = useState<string | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const loadStatus = useCallback(async () => {
    try {
      const response = await fetch("/api/status", { cache: "no-store" });
      setStatus(await readJsonResponse<MachineStatus>(response));
    } catch {
      setStatus({ online: false, queueRunning: 0, queuePending: 0 });
    }
  }, []);

  const loadHistory = useCallback(async () => {
    try {
      const response = await fetch("/api/history", { cache: "no-store" });
      const payload = await readJsonResponse<{ items?: HistoryItem[] }>(response);
      const items: HistoryItem[] = payload.items ?? [];
      setHistory(items);
      if (items[0]) {
        const latest = `/api/view?filename=${encodeURIComponent(items[0].filename)}&subfolder=${encodeURIComponent(items[0].subfolder)}&type=output`;
        setVideoUrl((current) => current ?? latest);
      }
    } catch {
      setHistory([]);
    }
  }, []);

  const loadQueue = useCallback(async () => {
    try {
      const response = await fetch("/api/queue", { cache: "no-store" });
      const payload = await readJsonResponse<{ jobs?: QueueJob[] }>(response);
      setQueueJobs(payload.jobs ?? []);
    } catch {
      setQueueJobs([]);
    }
  }, []);

  const loadCharacters = useCallback(async () => {
    try {
      const response = await fetch("/api/characters", { cache: "no-store" });
      const payload = await readJsonResponse<{ items?: CharacterProfile[] }>(response);
      setCharacters(payload.items ?? []);
    } catch {
      setCharacters([]);
    }
  }, []);

  const refreshStudio = useCallback(() => {
    void Promise.all([loadStatus(), loadHistory(), loadQueue()]);
  }, [loadHistory, loadQueue, loadStatus]);

  useEffect(() => {
    refreshStudio();
    void loadCharacters();
    const interval = window.setInterval(refreshStudio, 4_000);
    return () => window.clearInterval(interval);
  }, [loadCharacters, refreshStudio]);

  useEffect(() => {
    window.localStorage.removeItem("h3-gemini-api-key");
    setAutoEnhance(window.localStorage.getItem("h3-gemini-auto-enhance") !== "false");
  }, []);

  useEffect(() => {
    if (mode === "r2v" && selectedCharacterIds.length > 1 && Number(quality) < 0.6) {
      setQuality("0.6");
    }
  }, [mode, quality, selectedCharacterIds.length]);

  const setSelectedImage = (file: File | null) => {
    if (imagePreview) URL.revokeObjectURL(imagePreview);
    setImageFile(file);
    setImagePreview(file ? URL.createObjectURL(file) : null);
  };

  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    setSelectedImage(event.target.files?.[0] ?? null);
  };

  const onDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    setIsDragging(false);
    const file = event.dataTransfer.files?.[0];
    if (file?.type.startsWith("image/")) setSelectedImage(file);
  };

  const updateAutoEnhance = (enabled: boolean) => {
    setAutoEnhance(enabled);
    if (!enabled) setNarrationSegments([]);
    window.localStorage.setItem("h3-gemini-auto-enhance", String(enabled));
  };

  const saveCharacter = async () => {
    if (!characterName.trim() || !characterFile || savingCharacter) return;
    setSavingCharacter(true);
    setError(null);
    try {
      const body = new FormData();
      body.set("name", characterName.trim());
      body.set("description", characterDescription.trim());
      body.set("image", characterFile);
      const response = await fetch("/api/characters", { method: "POST", body });
      const payload = await readJsonResponse<{ profile: CharacterProfile; error?: string }>(response);
      if (!response.ok) throw new Error(payload.error || "Could not save the character.");
      setCharacters((current) => [payload.profile, ...current]);
      setSelectedCharacterIds((current) => [...current, payload.profile.id].slice(0, 9));
      setCharacterName("");
      setCharacterDescription("");
      setCharacterFile(null);
      setNotice(`${payload.profile.name} is saved to your character library.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save the character.");
    } finally {
      setSavingCharacter(false);
    }
  };

  const moveSelectedCharacter = (id: string, direction: -1 | 1) => {
    setSelectedCharacterIds((current) => {
      const from = current.indexOf(id);
      const to = from + direction;
      if (from < 0 || to < 0 || to >= current.length) return current;
      const next = [...current];
      [next[from], next[to]] = [next[to], next[from]];
      return next;
    });
  };

  const generate = async () => {
    if (!status.online || submitting || !prompt.trim()) return;
    if (mode === "i2v" && !imageFile) {
      setError("Add a starting image for image-to-video generation.");
      return;
    }
    if (mode === "r2v" && !status.r2vModelReady) {
      setError("The H3 reference model is still downloading. This mode will unlock automatically when it is ready.");
      return;
    }
    if (mode === "r2v" && selectedCharacterIds.length === 0) {
      setError("Select at least one saved character for reference-to-video.");
      return;
    }
    if (autoEnhance && !status.geminiConfigured) {
      setError("Gemini is not configured on the render machine. Turn off Auto-enhance to queue the original prompt.");
      return;
    }
    if (!autoEnhance && narrationEnabled && !narrationText.trim()) {
      setError("Add the exact narration or dialogue for the TTS version.");
      return;
    }
    setError(null);
    setNotice(null);
    setSubmitting(true);

    try {
      const originalPrompt = prompt.trim();
      let finalPrompt = originalPrompt;
      let finalNarrationText = narrationText.trim();
      let finalNarrationEnabled = narrationEnabled;
      let finalNarrationSegments = narrationSegments;
      let enhancementNotice = "";

      if (autoEnhance) {
        setSubmissionPhase("enhancing");
        const enhancementResponse = await fetch("/api/enhance", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            prompt: finalPrompt,
            duration,
            aspect,
            mode,
            characters: selectedCharacterIds.map((id, index) => {
              const character = characters.find((item) => item.id === id);
              return { tag: `<Picture ${index + 1}>`, name: character?.name, description: character?.description };
            }),
          }),
        });
        const enhancement = await readJsonResponse<EnhancementPayload>(enhancementResponse);
        if (!enhancementResponse.ok) throw new Error(enhancement.error || "Gemini could not enhance the prompt.");

        finalPrompt = enhancement.videoPrompt || finalPrompt;
        finalNarrationText = enhancement.narrationText || "";
        finalNarrationSegments = Array.isArray(enhancement.narrationSegments) ? enhancement.narrationSegments : [];
        finalNarrationEnabled = finalNarrationSegments.length > 0;
        setPrompt(finalPrompt);
        setNarrationText(finalNarrationText);
        setNarrationSegments(finalNarrationSegments);
        setNarrationEnabled(finalNarrationEnabled);
        enhancementNotice = finalNarrationEnabled
          ? ` Gemini prepared ${enhancement.narrationMode === "dialogue" ? `${finalNarrationSegments.length} timed speaker lines` : `${enhancement.narrationLanguage} narration`}.`
          : " Gemini kept this shot speech-free.";
        if (finalNarrationEnabled && !enhancement.narrationSupported) {
          enhancementNotice += ` ${enhancement.narrationLanguage} is not officially supported by IndicF5, so pronunciation may be unreliable.`;
        }
      }

      if (finalNarrationEnabled && !status.narrationOnline) {
        throw new Error("IndicF5 is offline, so the generated narration cannot be queued yet.");
      }
      if (finalNarrationEnabled && finalNarrationSegments.length === 0 && narrationVoice === "custom" && (!voiceFile || !voiceTranscript.trim())) {
        throw new Error("The selected custom voice needs a reference recording and its exact transcript.");
      }

      const body = new FormData();
      body.set("mode", mode);
      body.set("prompt", finalPrompt);
      body.set("originalPrompt", originalPrompt);
      body.set("promptEnhanced", String(autoEnhance));
      body.set("aspect", aspect);
      body.set("quality", quality);
      body.set("duration", String(duration));
      body.set("steps", String(steps));
      body.set("seed", String(seed));
      body.set("narrationEnabled", String(finalNarrationEnabled));
      if (mode === "r2v") {
        body.set("characterIds", JSON.stringify(selectedCharacterIds));
        body.set("referenceFidelity", referenceFidelity);
        body.set("referenceLayout", selectedCharacterIds.length > 1 ? "cast-board" : "separate");
      }
      if (finalNarrationEnabled) {
        body.set("narrationText", finalNarrationText);
        body.set("narrationVoice", narrationVoice);
        body.set("narrationSegments", JSON.stringify(finalNarrationSegments));
        if (finalNarrationSegments.length === 0 && narrationVoice === "custom" && voiceFile) {
          body.set("voiceAudio", voiceFile);
          body.set("voiceTranscript", voiceTranscript.trim());
        }
      }
      if (imageFile) body.set("image", imageFile);

      setSubmissionPhase("queueing");
      const response = await fetch("/api/generate", { method: "POST", body });
      const payload = await readJsonResponse<{ promptId?: string; error?: string }>(response);
      if (!response.ok) throw new Error(payload.error || "Could not start generation.");
      setNotice(`Added to the render queue.${enhancementNotice} You can submit another video now.`);
      setSeed(Math.floor(Math.random() * 999_999_999));
      refreshStudio();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Could not start generation.";
      setError(message === "Failed to fetch"
        ? "The studio connection dropped. The automatic recovery service is restarting it; retry in about 20 seconds."
        : message);
    } finally {
      setSubmissionPhase("idle");
      setSubmitting(false);
    }
  };

  const updateQueue = async (action: "cancel" | "clear", id?: string) => {
    const actionKey = id ?? action;
    setQueueAction(actionKey);
    setError(null);
    try {
      const response = await fetch("/api/queue", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, id }),
      });
      const payload = await readJsonResponse<{ error?: string }>(response);
      if (!response.ok) throw new Error(payload.error || "Could not update the queue.");
      refreshStudio();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not update the queue.");
    } finally {
      setQueueAction(null);
    }
  };

  const copyPrompt = async (text: string, label: string) => {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        textarea.remove();
      }
      setNotice(`${label} copied to your clipboard.`);
    } catch {
      setError(`Could not copy the ${label.toLowerCase()}.`);
    }
  };

  const promptCharacters = prompt.length;
  const narrationWords = narrationText.trim() ? narrationText.trim().split(/\s+/u).length : 0;
  const recommendedWords = Math.max(6, Math.floor(duration * 2.4));
  const narrationIsLong = narrationWords > Math.floor(recommendedWords * 1.35);

  return (
    <main className="app-shell">
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />

      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">H3</span>
          <div>
            <strong>Remote Studio</strong>
            <span>MiniMax video lab</span>
          </div>
        </div>
        <div className="machine-pill" data-online={status.online}>
          <span className="status-dot" />
          <span>{status.online ? "Studio online" : "Studio offline"}</span>
          {status.online && <small>{status.queueRunning ? "Generating" : "Ready"}</small>}
        </div>
      </header>

      <section className="hero">
        <div>
          <p className="eyebrow">PRIVATE • TAILSCALE SECURED</p>
          <h1>Turn a thought into motion.</h1>
          <p className="hero-copy">
            Direct your next shot from anywhere. Your Windows workstation does the rendering;
            this studio keeps the controls beautifully simple.
          </p>
        </div>
        <div className="machine-card">
          <div className="machine-card-head">
            <span>Render machine</span>
            <span className="live-label">LIVE</span>
          </div>
          <strong>{status.gpu?.replace("cuda:0 ", "") || "RTX workstation"}</strong>
          <div className="machine-metrics">
            <span><b>{status.vramFreeGb?.toFixed(1) ?? "—"} GB</b> VRAM free</span>
            <span><b>{status.queuePending}</b> queued</span>
            <span><b>v{status.version ?? "—"}</b> ComfyUI</span>
          </div>
        </div>
      </section>

      <section className="workspace-grid">
        <div className="creator-card">
          <div className="mode-switch" role="tablist" aria-label="Generation mode">
            <button className={mode === "t2v" ? "active" : ""} onClick={() => setMode("t2v")} role="tab">
              <span className="mode-icon">Aa</span>
              <span><b>Text to video</b><small>Start with an idea</small></span>
            </button>
            <button className={mode === "i2v" ? "active" : ""} onClick={() => setMode("i2v")} role="tab">
              <span className="mode-icon">◫</span>
              <span><b>Image to video</b><small>Animate a frame</small></span>
            </button>
            <button className={mode === "r2v" ? "active" : ""} onClick={() => setMode("r2v")} role="tab">
              <span className="mode-icon">ID</span>
              <span><b>Consistent characters</b><small>Reference to video</small></span>
            </button>
          </div>

          {mode === "i2v" && (
            <div className="form-block">
              <div className="label-row"><label>Starting frame</label><span>PNG, JPG or WebP</span></div>
              <label
                className={`dropzone ${isDragging ? "dragging" : ""} ${imagePreview ? "has-image" : ""}`}
                onDragOver={(event) => { event.preventDefault(); setIsDragging(true); }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={onDrop}
              >
                <input type="file" accept="image/png,image/jpeg,image/webp" onChange={onFileChange} />
                {imagePreview ? (
                  <>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={imagePreview} alt="Selected starting frame" />
                    <span className="replace-image">Choose a different image</span>
                  </>
                ) : (
                  <div className="dropzone-empty">
                    <span className="upload-mark">＋</span>
                    <b>Drop an image here</b>
                    <small>or click to browse</small>
                  </div>
                )}
              </label>
            </div>
          )}

          {mode === "r2v" && (
            <div className="form-block character-library">
              <div className="label-row">
                <label>Character library</label>
                <span className={status.r2vModelReady ? "model-ready" : "model-loading"}>{status.r2vModelReady ? "R2V model ready" : "R2V model downloading"}</span>
              </div>
              <p className="character-help">Choose the cast, then confirm the numbered reference map below. Use one clean portrait or full-body image per character—collages, text, and multiple poses cause identity drift.</p>
              {characters.length > 0 && (
                <div className="character-grid">
                  {characters.map((character) => {
                    const selectedIndex = selectedCharacterIds.indexOf(character.id);
                    return (
                      <button
                        type="button"
                        className={`character-card ${selectedIndex >= 0 ? "selected" : ""}`}
                        key={character.id}
                        onClick={() => setSelectedCharacterIds((current) => current.includes(character.id) ? current.filter((id) => id !== character.id) : [...current, character.id].slice(0, 9))}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={`/api/characters?image=${encodeURIComponent(character.id)}`} alt={`${character.name} reference`} />
                        <span className="character-order">{selectedIndex >= 0 ? selectedIndex + 1 : "+"}</span>
                        <span><b>{character.name}</b><small>{character.description || "Identity reference"}</small></span>
                      </button>
                    );
                  })}
                </div>
              )}
              {selectedCharacterIds.length > 0 && (
                <div className="reference-map">
                  <div className="reference-map-heading">
                    <b>References sent to MiniMax</b>
                    <span>{selectedCharacterIds.length > 1 ? "One automatic cast board prevents competing image contexts" : "The number below is the exact prompt mapping"}</span>
                  </div>
                  {selectedCharacterIds.length > 1 && (
                    <div className="cast-board-label"><code>&lt;Picture 1&gt;</code><span>Automatic board containing the cast in the order below</span></div>
                  )}
                  {selectedCharacterIds.map((id, index) => {
                    const character = characters.find((item) => item.id === id);
                    if (!character) return null;
                    return (
                      <div className="reference-map-row" key={id}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={`/api/characters?image=${encodeURIComponent(id)}`} alt="" />
                        <div>
                          <b><code>{selectedCharacterIds.length > 1 ? `<Subject ${index + 1}>` : "<Picture 1>"}</code> = {character.name}</b>
                          <small>{selectedCharacterIds.length > 1 ? `Placed ${castBoardPosition(index, selectedCharacterIds.length)} in <Picture 1>` : "Use <Subject 1> for this character in the scene"}</small>
                        </div>
                        <div className="reference-map-actions">
                          <button type="button" onClick={() => moveSelectedCharacter(id, -1)} disabled={index === 0} aria-label={`Move ${character.name} earlier`}>↑</button>
                          <button type="button" onClick={() => moveSelectedCharacter(id, 1)} disabled={index === selectedCharacterIds.length - 1} aria-label={`Move ${character.name} later`}>↓</button>
                          <button type="button" onClick={() => setSelectedCharacterIds((current) => current.filter((entry) => entry !== id))} aria-label={`Remove ${character.name}`}>×</button>
                        </div>
                      </div>
                    );
                  })}
                  <p>Character names stay in the Studio and voice plan. The H3 visual prompt uses neutral Subject labels so a famous name cannot override your reference image. Multi-character R2V automatically builds the board and uses Detail quality.</p>
                </div>
              )}
              <div className="character-create">
                <input value={characterName} onChange={(event) => setCharacterName(event.target.value)} placeholder="Character name, e.g. Lord Rama" />
                <input value={characterDescription} onChange={(event) => setCharacterDescription(event.target.value)} placeholder="Identity notes (optional — Gemini analyzes the image)" />
                <label className="character-file"><span>{characterFile?.name || "Choose reference image"}</span><input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => setCharacterFile(event.target.files?.[0] ?? null)} /></label>
                <button onClick={saveCharacter} disabled={!characterName.trim() || !characterFile || savingCharacter}>{savingCharacter ? "Saving…" : "Save character"}</button>
              </div>
              <div className="reference-fidelity">
                <span>Identity strength</span>
                <button className={referenceFidelity === "match" ? "selected" : ""} onClick={() => setReferenceFidelity("match")}><b>Balanced</b><small>Faster references</small></button>
                <button className={referenceFidelity === "max" ? "selected" : ""} onClick={() => setReferenceFidelity("max")}><b>Maximum</b><small>Best consistency</small></button>
              </div>
            </div>
          )}

          <div className="form-block">
            <div className="label-row">
              <label htmlFor="prompt">Direction</label>
              <span>{promptCharacters} characters</span>
            </div>
            <textarea
              id="prompt"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="Describe the scene, motion, camera, and sound…"
              rows={7}
            />
            <div className="prompt-tips">
              <span>Try: camera movement</span>
              <span>ambient sound</span>
              <span>lighting</span>
            </div>
            <div className="gemini-director">
              <div className="gemini-copy">
                <span className="gemini-mark">G</span>
                <span><b>Gemini prompt director</b><small>Directs the shot, casts male and female voices, and builds a timed speaker plan.</small></span>
              </div>
              <div className="gemini-actions">
                <div className="gemini-server-key" data-ready={status.geminiConfigured === true}>
                  <span className="status-dot" />
                  <span><b>{status.geminiConfigured ? "Secure key ready" : "Key not configured"}</b><small>Stored only on the render machine</small></span>
                </div>
                <label className="gemini-auto-toggle">
                  <input type="checkbox" checked={autoEnhance} onChange={(event) => updateAutoEnhance(event.target.checked)} />
                  <span className="gemini-switch"><i /></span>
                  <span><b>Auto-enhance</b><small>Runs before every queued video</small></span>
                </label>
              </div>
            </div>
          </div>

          <section className={`narration-block ${narrationEnabled ? "enabled" : ""}`}>
            <div className="narration-head">
              <div>
                <span className="audio-mark">VO</span>
                <span><b>IndicF5 dialogue</b><small>{autoEnhance ? "Gemini decides when speech is needed and assigns each voice" : status.narrationOnline ? (status.narrationActive ? "Generating a voice track" : "Manual voice engine ready") : "Voice engine setup required"}</small></span>
              </div>
              <label className="toggle">
                <input type="checkbox" checked={narrationEnabled} disabled={!status.narrationOnline || autoEnhance} onChange={(event) => setNarrationEnabled(event.target.checked)} />
                <span />
              </label>
            </div>
            {narrationEnabled && (
              <div className="narration-controls">
                {narrationSegments.length > 0 ? (
                  <div className="speaker-timeline">
                    <div className="label-row"><label>Gemini speaker timeline</label><span>{narrationSegments.length} {narrationSegments.length === 1 ? "line" : "lines"}</span></div>
                    {narrationSegments.map((segment, index) => (
                      <div className="speaker-line" key={`${segment.speaker}-${index}`}>
                        <div className="speaker-meta">
                          <b>{segment.speaker}</b>
                          <select
                            className="speaker-voice-select"
                            aria-label={`${segment.speaker} voice`}
                            value={segment.voice}
                            onChange={(event) => setNarrationSegments((current) => current.map((line, lineIndex) => lineIndex === index ? { ...line, voice: event.target.value as "male" | "female" } : line))}
                          >
                            <option value="male">Male voice</option>
                            <option value="female">Female voice</option>
                          </select>
                          <small>{segment.startSeconds.toFixed(1)}–{segment.endSeconds.toFixed(1)}s · {segment.language}</small>
                        </div>
                        <textarea
                          aria-label={`${segment.speaker} spoken line`}
                          value={segment.text}
                          rows={2}
                          onChange={(event) => setNarrationSegments((current) => current.map((line, lineIndex) => lineIndex === index ? { ...line, text: event.target.value } : line))}
                        />
                      </div>
                    ))}
                    <p className="timing-hint">Each character keeps a gender-matched voice, and every line is placed in its own non-overlapping time window.</p>
                  </div>
                ) : (
                  <>
                    <div className="label-row"><label htmlFor="narration">Exact spoken script</label><span>{narrationWords} / ~{recommendedWords} words</span></div>
                    <textarea
                      id="narration"
                      className="narration-text"
                      value={narrationText}
                      onChange={(event) => setNarrationText(event.target.value)}
                      placeholder="Write the exact words to be spoken in Hindi, Telugu, Tamil, Kannada, Malayalam, Marathi, Bengali, Gujarati, Punjabi, Assamese, or Odia…"
                      rows={4}
                    />
                    <p className={`timing-hint ${narrationIsLong ? "warning" : ""}`}>
                      {narrationIsLong ? "This script is likely too long. Shorten it to avoid rushed or clipped speech." : `Timing is tuned automatically to the ${duration}-second video.`}
                    </p>
                    <fieldset className="voice-picker">
                      <legend>Manual single voice</legend>
                      <div>
                        <button className={narrationVoice === "female" ? "selected" : ""} onClick={() => setNarrationVoice("female")}><b>Warm female</b><small>Built in</small></button>
                        <button className={narrationVoice === "male" ? "selected" : ""} onClick={() => setNarrationVoice("male")}><b>Calm male</b><small>Built in</small></button>
                        <button className={narrationVoice === "custom" ? "selected" : ""} onClick={() => setNarrationVoice("custom")}><b>Clone a voice</b><small>Your recording</small></button>
                      </div>
                    </fieldset>
                  </>
                )}
                {narrationSegments.length === 0 && narrationVoice === "custom" && (
                  <div className="custom-voice-grid">
                    <label className="voice-upload">
                      <span>{voiceFile ? voiceFile.name : "Choose a clean 5–15 second recording"}</span>
                      <input type="file" accept="audio/wav,audio/mpeg,audio/mp4,audio/flac,audio/ogg" onChange={(event) => setVoiceFile(event.target.files?.[0] ?? null)} />
                    </label>
                    <textarea value={voiceTranscript} onChange={(event) => setVoiceTranscript(event.target.value)} placeholder="Exact transcript of the reference recording" rows={3} />
                  </div>
                )}
                <div className="audio-versions"><span>1</span> Untouched H3 original <i>+</i><span>2</span> IndicF5-only dialogue — H3 audio fully removed</div>
              </div>
            )}
          </section>

          <div className="settings-grid">
            <fieldset>
              <legend>Aspect ratio</legend>
              <div className="option-row aspects">
                {ASPECTS.map((item) => (
                  <button key={item.value} className={aspect === item.value ? "selected" : ""} onClick={() => setAspect(item.value)}>
                    <span>{item.shape}</span><b>{item.value}</b><small>{item.label}</small>
                  </button>
                ))}
              </div>
            </fieldset>

            <fieldset>
              <legend>Render quality</legend>
              <div className="option-row qualities">
                {QUALITIES.map((item) => (
                  <button key={item.value} className={quality === item.value ? "selected" : ""} onClick={() => setQuality(item.value)}>
                    <b>{item.label}</b><small>{item.detail}</small>
                  </button>
                ))}
              </div>
            </fieldset>
          </div>

          <div className="fine-controls">
            <label>
              <span>Duration <b>{duration}s</b></span>
              <input type="range" min="3" max="12" step="1" value={duration} onChange={(event) => setDuration(Number(event.target.value))} />
            </label>
            <label>
              <span>Steps <b>{steps}</b></span>
              <input type="range" min="12" max="28" step="1" value={steps} onChange={(event) => setSteps(Number(event.target.value))} />
            </label>
            <label className="seed-control">
              <span>Seed</span>
              <div><input type="number" value={seed} onChange={(event) => setSeed(Number(event.target.value))} /><button onClick={() => setSeed(Math.floor(Math.random() * 999_999_999))} aria-label="Randomize seed">↻</button></div>
            </label>
          </div>

          {error && <div className="error-message"><span>!</span>{error}</div>}
          {notice && <div className="queue-notice"><span>✓</span>{notice}</div>}

          <button className="generate-button" onClick={generate} disabled={!status.online || submitting || !prompt.trim()}>
            {submitting ? <><span className="spinner" /> {submissionPhase === "enhancing" ? "Gemini directing shot" : "Adding to queue"}</> : <><span>＋</span> Add video to queue</>}
          </button>
          <p className="generation-note">Submit as many shots as you like • They render one at a time on your RTX 4090</p>
        </div>

        <aside className="result-column">
          <div className="result-card">
            <div className="section-title"><div><span>OUTPUT</span><h2>Your film</h2></div>{videoUrl && <a href={videoUrl} download>Download</a>}</div>
            <div className={`video-stage ${videoUrl ? "ready" : ""}`}>
              {videoUrl ? (
                <video src={videoUrl} controls autoPlay loop playsInline />
              ) : queueJobs.some((job) => job.state === "running") ? (
                <div className="progress-state">
                  <span className="large-spinner" />
                  <h3>Rendering the first job</h3>
                  <p>Sampling motion and sound. You can continue adding videos to the queue.</p>
                </div>
              ) : (
                <div className="empty-state">
                  <div className="film-mark"><span>▶</span></div>
                  <h3>Your next film starts here</h3>
                  <p>Set the direction and press generate. The finished video will appear right here.</p>
                </div>
              )}
            </div>
          </div>

          <div className="queue-panel">
            <div className="queue-panel-head">
              <div><span className="queue-icon">⌁</span><span><b>Render queue</b><small>{queueJobs.length ? "Keeps running if you close this page" : "Ready for your next batch"}</small></span></div>
              <div className="queue-head-actions">
                <strong>{queueJobs.length}</strong>
                {queueJobs.some((job) => job.state === "pending") && (
                  <button onClick={() => updateQueue("clear")} disabled={queueAction === "clear"}>Clear waiting</button>
                )}
              </div>
            </div>
            {queueJobs.length ? (
              <div className="queue-list">
                {queueJobs.map((job) => (
                  <article className="queue-job" key={job.id} data-state={job.state}>
                    <div className="queue-position">{job.state === "running" ? <span className="mini-spinner" /> : job.position}</div>
                    <div className="queue-job-copy">
                      <div><b>{job.state === "running" ? "Rendering now" : `Waiting · #${job.position}`}</b><span>{job.mode === "i2v" ? "Image → video" : job.mode === "r2v" ? "Reference → video" : "Text → video"}</span></div>
                      <p>{job.prompt}</p>
                      {job.speakerPlan && job.speakerPlan.length > 0 && (
                        <div className="voice-summary">{job.speakerPlan.map((line, index) => <span key={`${line.speaker}-${index}`} data-voice={line.voice}>{line.speaker} — {line.voice}</span>)}</div>
                      )}
                      <small>{job.width}×{job.height} · {job.duration}s · {job.steps} steps{job.narration ? " · IndicF5 narration" : ""}</small>
                    </div>
                    <button className="queue-remove" onClick={() => updateQueue("cancel", job.id)} disabled={queueAction === job.id} aria-label={job.state === "running" ? "Stop current render" : "Remove queued render"}>×</button>
                  </article>
                ))}
              </div>
            ) : (
              <div className="queue-empty"><span>0</span><p>No jobs waiting. Configure a shot and add it to the queue.</p></div>
            )}
          </div>
        </aside>
      </section>

      <section className="history-section">
        <div className="history-heading"><div><p className="eyebrow">COMPLETE ARCHIVE · {history.length} VIDEOS</p><h2>All generated videos</h2></div><button onClick={loadHistory}>Refresh</button></div>
        {history.length ? (
          <div className="history-grid">
            {history.map((item) => {
              const url = `/api/view?filename=${encodeURIComponent(item.filename)}&subfolder=${encodeURIComponent(item.subfolder)}&type=output`;
              return (
                <article key={item.id} className="history-item">
                  <video src={url} muted preload="metadata" playsInline />
                  <div className="history-overlay"><span>{item.mode === "i2v" ? "IMAGE → VIDEO" : item.mode === "r2v" ? "REFERENCE → VIDEO" : "TEXT → VIDEO"}</span><b>{item.narratedFilename ? "2 audio versions" : item.narrationRequested ? "Narration processing" : "Original audio"}</b></div>
                  <p>{item.originalPrompt ?? item.prompt}</p>
                  <details className="history-prompt-details">
                    <summary>View saved prompts</summary>
                    {item.originalPrompt ? (
                      <div className="saved-prompt">
                        <div><b>Original prompt</b><button onClick={() => copyPrompt(item.originalPrompt!, "Original prompt")}>Copy</button></div>
                        <p>{item.originalPrompt}</p>
                      </div>
                    ) : (
                      <div className="legacy-prompt-note">The original wording was not captured for this older render.</div>
                    )}
                    <div className="saved-prompt">
                      <div><b>{item.promptEnhanced ? "Gemini-enhanced prompt" : "Generation prompt"}</b><button onClick={() => copyPrompt(item.enhancedPrompt ?? item.prompt, "Generation prompt")}>Copy</button></div>
                      <p>{item.enhancedPrompt ?? item.prompt}</p>
                    </div>
                  </details>
                  {item.speakerPlan && item.speakerPlan.length > 0 && (
                    <div className="voice-summary history-voices">{item.speakerPlan.map((line, index) => <span key={`${line.speaker}-${index}`} data-voice={line.voice}>{line.speaker} — {line.voice}</span>)}</div>
                  )}
                  <div className="history-versions">
                    <button onClick={() => { setVideoUrl(url); window.scrollTo({ top: 0, behavior: "smooth" }); }}>Original</button>
                    {item.narratedFilename ? (
                      <button className="narrated" onClick={() => {
                        const narratedUrl = `/api/view?filename=${encodeURIComponent(item.narratedFilename!)}&subfolder=${encodeURIComponent(item.subfolder)}&type=output`;
                        setVideoUrl(narratedUrl);
                        window.scrollTo({ top: 0, behavior: "smooth" });
                      }}>IndicF5 only</button>
                    ) : item.narrationRequested ? <span><i className="mini-spinner" /> Voice pending</span> : null}
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="no-history">Every generated MP4 in your render archive will appear here.</div>
        )}
      </section>

      <footer><span>H3 Remote Studio</span><span>Private on your tailnet • Powered by ComfyUI + MiniMax H3</span></footer>
    </main>
  );
}
