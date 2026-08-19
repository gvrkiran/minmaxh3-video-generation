import { getCharacter, listCharacters, removeCharacter, saveCharacter } from "@/lib/characters";
import { promises as fs } from "node:fs";

export const dynamic = "force-dynamic";

async function describeCharacterImage(image: File) {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw new Error("Add identity notes for this character; automatic image analysis is unavailable.");
  const model = process.env.GEMINI_MODEL?.trim() || "gemini-3.6-flash";
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        contents: [{
          role: "user",
          parts: [
            { text: "Describe only the visible character for a video identity-reference prompt. Use one compact English sentence under 110 words. State exact face shape, skin color, eye color, hair and headwear, body proportions, clothing and colors, jewelry or props, and the precise illustration or photographic style. Do not identify or name the person, infer mythology or culture, or add anything not visibly present." },
            { inlineData: { mimeType: image.type, data: Buffer.from(await image.arrayBuffer()).toString("base64") } },
          ],
        }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 220 },
      }),
      signal: AbortSignal.timeout(60_000),
    },
  );
  if (!response.ok) throw new Error("Add identity notes for this character; automatic image analysis failed.");
  const result = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  const description = result.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join(" ").trim();
  if (!description) throw new Error("Add identity notes for this character; automatic image analysis returned no description.");
  return description.slice(0, 500);
}

export async function GET(request: Request) {
  try {
    const id = new URL(request.url).searchParams.get("image");
    if (id) {
      const { profile, imagePath } = await getCharacter(id);
      return new Response(await fs.readFile(imagePath), {
        headers: { "content-type": profile.mimeType, "cache-control": "private, max-age=3600" },
      });
    }
    return Response.json({ items: await listCharacters() });
  } catch {
    return Response.json({ error: "Character profile not found." }, { status: 404 });
  }
}

export async function POST(request: Request) {
  try {
    const data = await request.formData();
    const image = data.get("image");
    if (!(image instanceof File) || !image.type.startsWith("image/")) {
      return Response.json({ error: "Choose a character reference image." }, { status: 400 });
    }
    const suppliedDescription = String(data.get("description") ?? "").trim();
    const profile = await saveCharacter({
      name: String(data.get("name") ?? ""),
      description: suppliedDescription || await describeCharacterImage(image),
      image,
    });
    return Response.json({ profile });
  } catch (caught) {
    return Response.json({ error: caught instanceof Error ? caught.message : "Could not save the character." }, { status: 400 });
  }
}

export async function DELETE(request: Request) {
  try {
    const body = await request.json() as { id?: string };
    if (!body.id) return Response.json({ error: "Character id is required." }, { status: 400 });
    await removeCharacter(body.id);
    return Response.json({ ok: true });
  } catch {
    return Response.json({ error: "Could not remove the character." }, { status: 400 });
  }
}
