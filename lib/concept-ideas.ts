/**
 * Concepts to fall back on when the idea model cannot be reached.
 *
 * "Surprise me" on /concept asks the model for ideas nobody here has made (`/api/concept/idea`);
 * this list answers only when that call fails, and the page says so. It is bilingual because
 * the box is edited in whichever language the page is showing, and a Telugu reader handed an
 * English line would have to translate it before changing a word.
 *
 * Every line here can be told without a face and without writing in frame, which is the one
 * constraint a fallback must share with the brief: a seed that needs a sign or a screen would
 * plan cleanly and then render garbage text.
 */

export type IdeaSeed = { te: string; en: string };

export const SEEDS: readonly IdeaSeed[] = [
  { te: "వందలో పది రూపాయలు పొదుపు చేయడం ఎలా అలవాటు చేసుకోవాలి",
    en: "how to make a habit of saving ten rupees from every hundred" },
  { te: "వర్షాకాలంలో బియ్యం పురుగు పట్టకుండా ఎలా నిల్వ చేయాలి",
    en: "how to store rice through the monsoon without weevils" },
  { te: "ఉదయం లేవగానే ఒక గ్లాసు నీళ్లు ఎందుకు తాగాలి",
    en: "why drink a glass of water first thing in the morning" },
  { te: "ప్రెషర్ కుక్కర్ విజిల్ ఎలా పని చేస్తుంది",
    en: "how a pressure cooker whistle works" },
  { te: "మట్టి కుండలో నీళ్లు ఎందుకు చల్లగా ఉంటాయి",
    en: "why water in a clay pot stays cool" },
  { te: "పెరుగు తోడు పెట్టడం వెనుక ఉన్న సైన్స్",
    en: "the science behind setting curd with a spoon of starter" },
  { te: "ఇంటి ముందు తులసి మొక్క ఎందుకు పెంచుతారు",
    en: "why homes keep a tulasi plant at the door" },
  { te: "పాత నూలు చీరతో ఇంట్లో ఏమేమి చేయవచ్చు",
    en: "what an old cotton saree can become around the house" },
  { te: "పిల్లలకు సమయం విలువ ఎలా నేర్పాలి",
    en: "how to teach children the value of time" },
  { te: "వాన నీటిని ఇంట్లో ఎలా పట్టి దాచుకోవాలి",
    en: "how to catch and keep rainwater at home" },
  { te: "మామిడి పండు మగ్గిందో లేదో ఎలా తెలుసుకోవాలి",
    en: "how to tell when a mango is ripe" },
  { te: "వేసవిలో ఇంటిని చల్లగా ఉంచే పాత పద్ధతులు",
    en: "old ways of keeping a house cool in summer" },
  { te: "కూరగాయల తొక్కలు ఎరువుగా ఎలా మారుతాయి",
    en: "how vegetable peels become compost" },
  { te: "రోజూ పది నిమిషాల నడక శరీరానికి ఏం చేస్తుంది",
    en: "what ten minutes of walking a day does for the body" },
  { te: "పసుపు దాదాపు ప్రతి వంటలో ఎందుకు ఉంటుంది",
    en: "why turmeric is in nearly every dish" },
  { te: "ఇనుప కడాయి ఎందుకు మంచిది",
    en: "why an iron pan is worth the trouble" },
  { te: "నెలకు సరిపడా బస్సు డబ్బు ఎలా విడిగా పెట్టుకోవాలి",
    en: "how to set aside bus money for the month" },
  { te: "వేరుశనగ మొక్క నుంచి నూనె సీసా వరకు ప్రయాణం",
    en: "the journey from a groundnut plant to a bottle of oil" },
  { te: "సంక్రాంతి రోజు కొత్త బియ్యం ఎందుకు వండుతారు",
    en: "why new rice is cooked on Sankranti" },
  { te: "మీగడతో ఇంట్లో నెయ్యి ఎలా తీయాలి",
    en: "how ghee is made at home from cream" },
  { te: "పెన్సిల్ ఎలా తయారవుతుంది",
    en: "how a pencil is made" },
  { te: "మొక్కకు ఎప్పుడు నీళ్లు పోయాలో ఎలా తెలుస్తుంది",
    en: "how to tell when a plant needs water" },
  { te: "చిన్న పిల్లలకు డబ్బు లెక్క ఎలా నేర్పాలి",
    en: "how to teach small children to count money" },
  { te: "తేనెటీగలు లేకపోతే మన కూరగాయలకు ఏమవుతుంది",
    en: "what happens to our vegetables without bees" },
];

type Rng = () => number;

/** `n` distinct seeds in the box's language, in random order. */
export function surpriseIdeas(n: number, lang: "te" | "en", rng: Rng = Math.random): string[] {
  const pool = [...SEEDS];
  const out: string[] = [];
  while (pool.length && out.length < n) {
    const i = Math.floor(rng() * pool.length);
    out.push(pool.splice(i, 1)[0][lang]);
  }
  return out;
}
