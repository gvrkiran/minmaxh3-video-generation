function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const GENERIC_NAME_WORDS = new Set([
  "character",
  "goddess",
  "lord",
  "mister",
  "miss",
  "person",
  "subject",
  "woman",
  "young",
]);

export function castBoardPosition(index: number, count: number) {
  if (count <= 1) return "only";
  if (count === 2) return index === 0 ? "left" : "right";
  if (count === 3) return ["left", "center", "right"][index] ?? "right";

  const columns = count === 4 ? 2 : 3;
  const row = Math.floor(index / columns);
  const column = index % columns;
  const rowNames = count === 4 ? ["top", "bottom"] : ["top", "middle", "bottom"];
  const columnNames = columns === 2 ? ["left", "right"] : ["left", "center", "right"];
  return `${rowNames[row] ?? "bottom"} ${columnNames[column] ?? "right"}`;
}

/**
 * H3 can substitute its learned idea of a famous character for the supplied
 * picture. Keep real names in the UI/TTS plan, but make the visual prompt use
 * only the stable Subject labels. Dialogue tags are protected verbatim.
 */
export function neutralizeReferenceCharacterNames(prompt: string, names: string[]) {
  const parts = prompt.split(/(<d>[\s\S]*?<\/d>)/giu);

  const neutralized = parts.map((part, partIndex) => {
    if (partIndex % 2 === 1) return part;

    return names.reduce((current, rawName, index) => {
      const subject = `<Subject ${index + 1}>`;
      const name = rawName.trim();
      if (!name) return current;

      const aliases = new Set([name]);
      const words = name.split(/\s+/u).filter((word) => word.length >= 4 && !GENERIC_NAME_WORDS.has(word.toLowerCase()));
      if (words.length) aliases.add(words[words.length - 1]);

      let next = current;
      for (const alias of [...aliases].sort((a, b) => b.length - a.length)) {
        const escaped = escapeRegExp(alias);
        next = next.replace(new RegExp(`\\s*\\(\\s*${escaped}\\s*\\)`, "giu"), "");
        next = next.replace(new RegExp(`\\b${escaped}\\b`, "giu"), subject);
      }
      return next;
    }, part);
  }).join("");

  let result = neutralized;
  names.forEach((_, index) => {
    const number = index + 1;
    const escapedSubject = `<Subject\\s+${number}>`;
    result = result
      .replace(new RegExp(`(<Subject ${number}>)\\s+is\\s+${escapedSubject}\\s+from`, "giu"), `$1 is the character in`)
      .replace(new RegExp(`(<Subject ${number}>)\\s*\\(\\s*${escapedSubject}\\s*\\)`, "giu"), `$1`);
  });

  return result.replace(
    /fully_preserved\s+(<Subject\s+\d+>)\s*:\s*/giu,
    "$1 (appears in [Shot 1]): fully_preserved - ",
  );
}
