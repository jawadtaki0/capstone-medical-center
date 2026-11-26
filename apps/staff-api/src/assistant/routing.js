import { TOPIC_IDS } from "./topics.js";
import { plain } from "./text.js";
import { withoutDetails } from "./prefill.js";

// Below ACCEPT, or this close to the runner-up, the assistant offers buttons
// instead of guessing.
export const ACCEPT = 0.87;
export const MARGIN = 0.008;

export const detectLanguage = (text) =>
  (text.match(/\p{Script=Arabic}/gu)?.length ?? 0) >
  (text.match(/\p{Script=Latin}/gu)?.length ?? 0)
    ? "ar"
    : "en";

const SKIP_CONFIRMATION = [
  /\b(without|skip|no need (for|to)|don'?t|do not|bypass)\b.{0,30}\bconfirm/,
  /\bconfirm\w*\b.{0,20}\b(not needed|unnecessary)/,
  /(بدون|بلا|دون|من غير|تخطي|تجاوز).{0,20}(تاكيد|ما ?تسال|ما ?تاكد|موافق)/,
];

// A sentence that opens with the command itself needs no guessing. Questions
// ("how do I cancel") and Lab requests go to the matcher.
const LAB_WORDS =
  /\b(lab|order|sample|specimen|result|report)\b|مختبر|عينه|نتيجه|تقرير|فحص/;
const OPENING = /^(please |can you |i want to |i need to |بدي |اريد |من فضلك )?/
  .source;
const COMMANDS = [
  [
    "reschedule_help",
    "(reschedule|postpone)\\b|(اجل|أجل|غير) (موعد|الحجز|حجز)",
  ],
  ["cancel_booking_help", "cancel\\b|(الغي|الغ|الغاء) "],
  ["book_help", "book\\b|احجز "],
].map(([topic, verb]) => [topic, new RegExp(`${OPENING}(${verb})`)]);

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
  // "Prepare ..." asks for a draft report, even though it names an order.
  if (new RegExp(`${OPENING}(prepare|حضر|جهز)( |$)`).test(text))
    return result("topic", "lab_prepare_help");
  // Asking to create someone's account opens the form, not the how-to.
  if (
    new RegExp(
      `${OPENING}((create|add|make|set up) .{0,30}account|(اعمل|انشئ|ضيف) .{0,10}حساب)`,
    ).test(text)
  )
    return result("topic", "staff_create");
  const command =
    !LAB_WORDS.test(text) && COMMANDS.find(([, pattern]) => pattern.test(text));
  if (command) return result("topic", command[0]);
  if (!matcher) return result("unavailable");
  // Names and dates say who and when, not what is wanted.
  const ranked = await matcher.rank(withoutDetails(message));
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
