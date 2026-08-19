import { promises as fs } from "node:fs";
import path from "node:path";

export type CharacterProfile = {
  id: string;
  name: string;
  description: string;
  filename: string;
  mimeType: string;
  createdAt: number;
};

const CHARACTER_ROOT = path.join(process.cwd(), "work", "characters");

function safeId(id: string) {
  if (!/^[a-f0-9-]{20,64}$/i.test(id)) throw new Error("Invalid character profile.");
  return id;
}

async function ensureRoot() {
  await fs.mkdir(CHARACTER_ROOT, { recursive: true });
}

export async function listCharacters() {
  await ensureRoot();
  const files = await fs.readdir(CHARACTER_ROOT);
  const profiles = await Promise.all(files.filter((name) => name.endsWith(".json")).map(async (name) => {
    try {
      return JSON.parse(await fs.readFile(path.join(CHARACTER_ROOT, name), "utf8")) as CharacterProfile;
    } catch {
      return null;
    }
  }));
  return profiles.filter((profile): profile is CharacterProfile => Boolean(profile))
    .sort((a, b) => b.createdAt - a.createdAt);
}

export async function getCharacter(id: string) {
  await ensureRoot();
  const profile = JSON.parse(await fs.readFile(path.join(CHARACTER_ROOT, `${safeId(id)}.json`), "utf8")) as CharacterProfile;
  return { profile, imagePath: path.join(CHARACTER_ROOT, profile.filename) };
}

export async function saveCharacter(options: { name: string; description: string; image: File }) {
  await ensureRoot();
  const mimeExtensions: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
  };
  const extension = mimeExtensions[options.image.type];
  if (!extension) throw new Error("Use a JPG, PNG, or WebP character image.");
  if (options.image.size > 20 * 1024 * 1024) throw new Error("Character images must be smaller than 20 MB.");
  const id = crypto.randomUUID();
  const filename = `${id}${extension}`;
  const profile: CharacterProfile = {
    id,
    name: options.name.trim().slice(0, 80),
    description: options.description.trim().slice(0, 500),
    filename,
    mimeType: options.image.type,
    createdAt: Date.now(),
  };
  if (!profile.name) throw new Error("Give this character a name.");
  await fs.writeFile(path.join(CHARACTER_ROOT, filename), Buffer.from(await options.image.arrayBuffer()));
  await fs.writeFile(path.join(CHARACTER_ROOT, `${id}.json`), JSON.stringify(profile, null, 2), "utf8");
  return profile;
}

export async function removeCharacter(id: string) {
  const { profile, imagePath } = await getCharacter(id);
  await fs.rm(imagePath, { force: true });
  await fs.rm(path.join(CHARACTER_ROOT, `${safeId(profile.id)}.json`), { force: true });
}
