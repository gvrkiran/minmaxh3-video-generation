/**
 * Idea seeds for the painting reels -- the FALLBACK behind "Surprise me" and "Suggest ideas".
 *
 * Those buttons ask the model (`/api/paint/idea`, backed by ReelsLab's `suggest_ideas.py`) for
 * ideas that are new here: it is shown everything already made and told to stay away from it.
 * This file is what answers when the model cannot -- no key, no network, a timeout -- so the
 * button never does nothing. The page says when an idea came from here rather than the model.
 *
 * A line pairs one subject with one medium; the planning model still chooses the palette,
 * the surface's exact character, the hands and the place, which is where its judgement is
 * actually good.
 *
 * No subject here carries a human or divine face, because the faceless rule extends to the
 * painting itself: the video model is told there is no face anywhere in frame, and a painted
 * one would contradict it. Dancers appear as anklets and feet, deities as their emblems,
 * people from behind.
 *
 * Plain English on purpose -- these lines are read by the model, not by her, and both pages
 * put them in the box to be edited before anything is made.
 */

export const MEDIUMS: readonly string[] = [
  "transparent watercolour on rough handmade paper",
  "wet-on-wet watercolour, the colours left to bloom on their own",
  "watercolour with salt and wax resist for texture",
  "gouache on toned grey paper",
  "acrylic laid on thickly with a palette knife",
  "oil paint in heavy impasto strokes on canvas",
  "soft pastels on sanded paper, blended with a fingertip",
  "charcoal and white chalk on brown kraft paper",
  "black ink with a bamboo nib, then a grey wash",
  "coloured pencils layered slowly on smooth paper",
  "Madhubani style, with a bamboo nib and natural colours",
  "Warli style, white rice paste on an ochre mud wall",
  "Kalamkari style, with a kalam pen on cotton cloth",
  "Pattachitra style, fine brushes on primed cloth",
  "Tanjore style, with gesso relief and gold foil pressed on",
  "Gond style, built from dots and dashes in bright colours",
  "Kerala mural style, in the five traditional colours",
  "Pichwai style, with lotus and dense foliage",
  "Rajasthani miniature style, with a single-hair brush",
  "rangoli, coloured powders poured from between the fingers",
  "kolam, rice flour drawn on a wet red floor",
  "alpana, rice paste painted on a red cement floor",
  "lippan work, mud relief with small mirrors pressed in",
  "fabric paint on a cotton dupatta stretched on a frame",
  "glass painting, with black outliner and glass colours",
  "enamel colours on a terracotta pot",
  "coffee painting, in layered brown washes",
  "coloured sand poured onto a black board",
  "marbling, colours floated on water and lifted with paper",
  "block printing with a carved wooden block and natural dye",
  "a lime-wash mural on a village wall",
  "spray paint and cut stencils on a brick wall",
  "finger painting with thick acrylics",
  "sponge and stencil painting for texture",
  "chalk pastels on a slate board",
  "turmeric, kumkum and rice paste on a banana leaf",
];

export const SUBJECTS: readonly string[] = [
  "a peacock on a mango branch",
  "lotus flowers on a pond at dawn",
  "monsoon rain over a village street",
  "a banyan tree with hanging roots",
  "fishing boats pulled up on a beach",
  "a temple elephant with a painted forehead, seen from behind",
  "a temple gopuram against an evening sky",
  "a flute and a peacock feather on folded silk",
  "a dancer's anklets and feet mid-step",
  "a heap of marigolds at a flower market",
  "ripe mangoes in a bamboo basket",
  "tea gardens on a misty hillside",
  "the Himalayas at sunrise",
  "an old Hyderabad street with the Charminar",
  "the ruins of Hampi in late golden light",
  "a kingfisher on a bent reed",
  "a tiger moving through tall dry grass",
  "an auto-rickshaw in the rain",
  "a brass lamp and a string of jasmine",
  "a village well under a neem tree",
  "cows walking home at dusk with dust rising",
  "a bullock cart on a red-earth road",
  "a paddy field with a single palm tree",
  "saris drying in colour on a riverbank",
  "a glass of chai on a wet railway platform",
  "lamps floating on a river at night",
  "a parrot on a guava tree",
  "a fishing net thrown at sunrise",
  "clay water pots on a woman's hip, seen from behind",
  "a mother and child under a red umbrella, seen from behind",
  "a coconut grove after rain",
  "a single peacock feather, life-size",
  "the sea at Visakhapatnam with the Dolphin's Nose",
  "sunflowers in a steel tumbler",
  "a stone Nandi in a temple courtyard",
  "a night market lit by tube lights",
  "a street dog asleep in a doorway",
  "hibiscus flowers against a dark wall",
  "red chillies drying on a rooftop",
  "a river ghat with steps going down into the water",
  "a jackfruit tree heavy with fruit",
  "a woman's hands kneading dough, seen from above",
  "a boat on the backwaters between coconut palms",
  "a herd of goats on a rocky hillside",
  "a rain-soaked cricket ground with one bat left out",
];

/** Random number in [0, 1). Injected so a test can make it deterministic. */
type Rng = () => number;

function shuffled<T>(items: readonly T[], rng: Rng): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** `n` idea lines, with no medium and no subject used twice within the set. */
export function suggestIdeas(n: number, rng: Rng = Math.random): string[] {
  const count = Math.max(0, Math.min(n, MEDIUMS.length, SUBJECTS.length));
  const mediums = shuffled(MEDIUMS, rng);
  const subjects = shuffled(SUBJECTS, rng);
  return Array.from({ length: count }, (_, i) => `${subjects[i]}, in ${mediums[i]}`);
}

export function surpriseIdea(rng: Rng = Math.random): string {
  return suggestIdeas(1, rng)[0];
}
