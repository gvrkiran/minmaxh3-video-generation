import { readFile } from "node:fs/promises";
import path from "node:path";

const base = process.env.H3_STUDIO_URL || "http://100.90.163.26:3000";
const boardName = "Sita, Rama & Lakshmana cast board";
const libraryResponse = await fetch(`${base}/api/characters`, { cache: "no-store" });
const library = (await libraryResponse.json()).items || [];
let board = library.find((item) => item.name === boardName);

if (!board) {
  const boardPath = path.resolve("work/r2v-diagnosis/sita-rama-lakshmana-cast-board.png");
  const bytes = await readFile(boardPath);
  const form = new FormData();
  form.set("name", boardName);
  form.set("description", "One ordered cast board: yellow-sari woman on the left, blue-skinned bowman in the center, tan-skinned bowman on the right. Preserve the polished 2D illustrated style.");
  form.set("image", new File([bytes], "sita-rama-lakshmana-cast-board.png", { type: "image/png" }));
  const saveResponse = await fetch(`${base}/api/characters`, { method: "POST", body: form });
  const saved = await saveResponse.json();
  if (!saveResponse.ok) throw new Error(saved.error || `Saving cast board returned ${saveResponse.status}.`);
  board = saved.profile;
}

const prompt = `subject_definitions:
<Subject 1> is the woman on the left in <Picture 1>, with the exact oval face, large brown eyes, long dark hair, yellow sari with orange-gold border, gold jewelry, slim proportions, and polished 2D illustrated rendering.
<Subject 2> is the blue-skinned man in the center of <Picture 1>, with the exact oval face, brown eyes, vertical tilak, high black topknot, blue skin, yellow dhoti, orange sash, gold jewelry, bow, quiver, athletic proportions, and polished 2D illustrated rendering; he has no crown.
<Subject 3> is the tan-skinned man on the right in <Picture 1>, with the exact angular face, brown eyes, vertical tilak, high black topknot, tan skin, yellow dhoti, orange sash, bow, quiver, athletic proportions, and polished 2D illustrated rendering.

summary:
[reference generation] The three defined subjects sit together around a small campfire in a quiet jungle clearing at twilight and have a short gentle conversation.

retention_analysis:
<Subject 1> (appears in [Shot 1]): fully_preserved - preserve the exact face, yellow sari, hair, jewelry, proportions, and 2D illustrated style from the left side of <Picture 1>.
<Subject 2> (appears in [Shot 1]): fully_preserved - preserve the exact blue skin, face, topknot, tilak, yellow-orange costume, bow, quiver, proportions, and 2D illustrated style from the center of <Picture 1>; no crown.
<Subject 3> (appears in [Shot 1]): fully_preserved - preserve the exact tan skin, face, topknot, tilak, yellow-orange costume, bow, quiver, proportions, and 2D illustrated style from the right side of <Picture 1>.

detailed_description:
The target video uses the same clean polished 2D animation style as <Picture 1>. [Shot 1] A fixed eye-level medium-wide composition shows <Subject 1> seated on the left, <Subject 2> seated in the center, and <Subject 3> seated on the right around a small campfire in a twilight forest. Their faces and costumes remain fully visible. <Subject 2> (S1) turns slightly toward <Subject 1> and says, <d>[Telugu] అయోధ్య జ్ఞాపకాలు వస్తున్నాయి.</d> He closes his lips and holds a quiet reflective expression while <Subject 1> listens. <Subject 1> (S2) replies gently, <d>[Telugu] మన ఇల్లు మన హృదయంలో ఉంది.</d> She closes her lips and smiles. <Subject 3> nods once. Only subtle breathing, blinking, cloth movement, and firelight motion occur. The camera does not cut or change angle. Prohibit photographic rendering, face drift, costume changes, identity blending, crowns, or swapping positions.

overall_soundscape: Quiet jungle night ambience, a gentle breeze, crickets, and soft campfire crackle.
non_diegetic_music: Very soft contemplative bamboo flute.`;

const form = new FormData();
form.set("mode", "r2v");
form.set("prompt", prompt);
form.set("originalPrompt", "Three-character cast-board consistency validation");
form.set("promptEnhanced", "false");
form.set("characterIds", JSON.stringify([board.id]));
form.set("referenceFidelity", "max");
form.set("aspect", "16:9");
form.set("quality", "0.6");
form.set("duration", "5");
form.set("steps", "20");
form.set("seed", "611427905");
form.set("narrationEnabled", "false");
form.set("narrationText", "");
form.set("narrationSegments", "[]");
form.set("narrationVoice", "female");

const generateResponse = await fetch(`${base}/api/generate`, { method: "POST", body: form });
const generation = await generateResponse.json();
if (!generateResponse.ok) throw new Error(generation.error || `Generation returned ${generateResponse.status}.`);
console.log(JSON.stringify({ promptId: generation.promptId, boardId: board.id }, null, 2));
