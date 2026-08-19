const base = process.env.H3_STUDIO_URL || "http://100.90.163.26:3000";
const idea = "rama, lakshmana, and sita sitting in the jungle talking in telugu about missing ayodhya";

const characterResponse = await fetch(`${base}/api/characters`, { cache: "no-store" });
if (!characterResponse.ok) throw new Error(`Character library returned ${characterResponse.status}.`);
const library = (await characterResponse.json()).items || [];

const findLatest = (name) => library.find((item) => item.name.toLowerCase() === name.toLowerCase());
const cast = [findLatest("sita"), findLatest("rama"), findLatest("lakshmana")];
if (cast.some((item) => !item)) throw new Error("The Sita, Rama, and Lakshmana references are not all present.");

let enhancement;
if (process.env.H3_SKIP_ENHANCE === "1") {
  enhancement = { videoPrompt: "subject_definitions:\n<Subject 1> is the left character in <Picture 1>.\n<Subject 2> is the center character in <Picture 1>.\n<Subject 3> is the right character in <Picture 1>.\n\nsummary:\n[reference generation] The three subjects sit together in a forest.\n\nretention_analysis:\n<Subject 1> (appears in [Shot 1]): fully_preserved - exact reference identity.\n<Subject 2> (appears in [Shot 1]): fully_preserved - exact reference identity.\n<Subject 3> (appears in [Shot 1]): fully_preserved - exact reference identity.\n\ndetailed_description:\n[Shot 1] <Subject 1>, <Subject 2>, and <Subject 3> sit together and smile gently.\n\noverall_soundscape: Quiet forest ambience.\nnon_diegetic_music: N/A" };
} else {
  const enhanceResponse = await fetch(`${base}/api/enhance`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      prompt: idea,
      duration: 3,
      aspect: "16:9",
      mode: "r2v",
      characters: cast.map((character, index) => ({
        tag: `<Picture ${index + 1}>`,
        name: character.name,
        description: character.description,
      })),
    }),
  });
  enhancement = await enhanceResponse.json();
  if (!enhanceResponse.ok) throw new Error(enhancement.error || `Enhancement returned ${enhanceResponse.status}.`);
}

const form = new FormData();
form.set("mode", "r2v");
form.set("prompt", enhancement.videoPrompt);
form.set("originalPrompt", idea);
form.set("promptEnhanced", "true");
form.set("characterIds", JSON.stringify(cast.map((character) => character.id)));
form.set("referenceFidelity", "max");
form.set("aspect", "16:9");
form.set("quality", "0.2");
form.set("duration", "3");
form.set("steps", "12");
form.set("seed", "482915703");
form.set("narrationEnabled", "false");
form.set("narrationText", "");
form.set("narrationSegments", "[]");
form.set("narrationVoice", "female");

const generateResponse = await fetch(`${base}/api/generate`, { method: "POST", body: form });
const generation = await generateResponse.json();
if (!generateResponse.ok) throw new Error(generation.error || `Generation returned ${generateResponse.status}.`);

console.log(JSON.stringify({
  promptId: generation.promptId,
  mapping: [
    "<Picture 1> = automatic cast board",
    ...cast.map((character, index) => `<Subject ${index + 1}> = ${character.name} (${["left", "center", "right"][index]})`),
  ],
  videoPrompt: enhancement.videoPrompt,
}, null, 2));
