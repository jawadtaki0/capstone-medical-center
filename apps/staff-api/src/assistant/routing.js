import { TOPIC_IDS } from "./topics.js";

// Below ACCEPT, or this close to the runner-up, the assistant offers buttons
// instead of guessing.
export const ACCEPT = 0.87;
export const MARGIN = 0.008;

export const detectLanguage = (text) =>
  (text.match(/\p{Script=Arabic}/gu)?.length ?? 0) >
  (text.match(/\p{Script=Latin}/gu)?.length ?? 0)
    ? "ar"
    : "en";

// Arabic letters that are commonly typed several ways, and diacritics.
export const plain = (text) =>
  text
    .normalize("NFKC")
    .replace(/[ً-ٰٟـ]/g, "")
    .replace(/[أإآ]/g, "ا")
    .toLowerCase();

const SKIP_CONFIRMATION = [
  /\b(without|skip|no need (for|to)|don'?t|do not|bypass)\b.{0,30}\bconfirm/,
  /\bconfirm\w*\b.{0,20}\b(not needed|unnecessary)/,
  /(بدون|بلا|دون|من غير|تخطي|تجاوز).{0,20}(تاكيد|ما ?تسال|ما ?تاكد|موافق)/,
];

export async function routeMessage(message, matcher) {
  const language = detectLanguage(message),
    text = plain(message);
  const result = (kind, topic = null, suggestions = []) => ({
    language,
    kind,
    topic,
    suggestions,
  });
  if (SKIP_CONFIRMATION.some((pattern) => pattern.test(text)))
    return result("confirmation_required");
  if (!matcher) return result("unavailable");
  const ranked = await matcher.rank(message);
  const [first, second] = ranked;
  const suggestions = ranked
    .filter((r) => TOPIC_IDS.includes(r.id) && r.id !== "capabilities")
    .slice(0, 6)
    .map((r) => r.id);
  if (first.score < ACCEPT || first.score - (second?.score ?? 0) < MARGIN)
    return result("unclear", null, suggestions);
  if (first.id === "clinical") return result("clinical");
  if (first.id === "outside") return result("unclear", null, []);
  return result("topic", first.id, suggestions);
}
