import { canon } from "./public-assistant-language.js";

export const cancelChatCopy = {
  en: "To cancel, open My account and choose the booking, or use your guest cancellation link. You’ll review and confirm the cancellation before it takes effect. Contact Cedar Reception if you need help.",
  ar: "لإلغاء موعد، افتح حسابي واختر الموعد، أو استخدم رابط إلغاء موعد الضيف. راجع تفاصيل الإلغاء وأكّده ليصبح نافذًا. تواصل مع استقبال سيدر إذا احتجت إلى المساعدة.",
};

const own =
  /\b(?:my|for me|to me|in my name|under my name)\b|(?:نتايجي|نتائج?ي|نتيجتي|تقريري|موعدي|حجزي|مواعيدي|حجوزاتي|حجوزاتنا|طلباتي|ابني|بنتي|طفلي|باسمي|تبعي|تبعنا|خصني|بحسابي|عحسابي|بملفي)/u;
const family =
  /\b(?:mom|mother|father|dad|wife|husband|sister|brother|aunt|uncle|cousin|friend|someone else|their|his|her)\b|(?<!\p{L})(?:امي|والدتي|ابي|والدي|اخي|اختي|زوجتي|خالتي|عمتي|صديقي)(?!\p{L})/u;
const booking =
  /\b(?:bookings?|appointments?|requests?|visits?)\b|موعد|مواعيد|حجز|حجوز|طلبات/u;
const recordAcquisition =
  /\b(?:pull up|look up|retrieve|download|access|show|send|see|view|print|open|get|copy)\b|(?:بدي|اريد|فرجيني|اعرض|ارسل|ابعث|ابعت|نزل|شوف|نسخه)/u;
const recordArtifact =
  /\b(?:printouts?|attachments?|sheets?|paper|copies|copy|report|record)\b|ورقه|نسخه|مرفق|تقرير|مستند/u;
const pastClinicalSource =
  /\b(?:blood|urine|swab|samples?|specimens?|tests?|nurse|lab)\b|مختبر|عينه|مسحه|الدم|البول|الممرض/u;
const personalCollection =
  /\b(?:from me|you (?:sent|gave|collected|took)|(?:i|we) (?:gave|provided|submitted|had|took))\b|(?:سحبتلي|سحبولي|اخدولي|اخدوا مني|عطيتكن|قدمتها|عملت[هو]|وصلتني|خصني)/u;

const results =
  /\b(?:results?|reports?|(?:lab(?:oratory)?|blood) (?:files?|documents?|tests?)|(?:files?|documents?) (?:cedar )?(?:issued|released|sent))\b|نتايج|نتائج|نتيج|تقارير|تقرير|تحاليل|فحوصات|ورقه (?:تبع )?(?:الفحص|فحص|تحليل)/u;

// Indirect wording about the visitor's own sample, request or test.
const indirectOwn =
  /\b(?:time|slot) i (?:asked|requested)\b|\bwhat did my (?:\w+ )?(?:test|scan) (?:show|say)\b|(?:سحبوه|سحبوها|اخدوه|اخدوها|اخذوه|اخذوها) مني|وين صار (?:طلبي|طلب (?:ابني|بنتي))|\b(?:i|we) (?:left|gave|dropped off|provided|submitted|did|had)\b.{0,40}\b(?:sample|swab|blood|urine|test|scan)\b.{0,60}\b(?:show|say|ready|come back|came back|results?)\b|(?:تركت|عطيت|عملت|قدمت)\S{0,3} .{0,30}(?:عينه|تحليل|فحص|مسحه|دم).{0,40}(?:طلع|بين|جاهز|نتيج)/u;

// The privacy check is deliberately wider than the account intent lookup.
// For example, a personal document can be identifiable without naming a supported action.
export function containsPrivateAccountText(message) {
  if (typeof message !== "string") return false;
  const text = canon(message);
  if (indirectOwn.test(text)) return true;
  if (
    /\b[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\b|\b(?:wr|lab|b)-[a-f0-9]{8,}\b|[\w.+-]+@[\w.-]+\.[a-z]{2,}/u.test(
      text,
    )
  )
    return true;
  if (
    recordAcquisition.test(text) &&
    recordArtifact.test(text) &&
    pastClinicalSource.test(text) &&
    (personalRecordOwner(text) || personalCollection.test(text))
  )
    return true;
  const record =
    results.test(text) ||
    booking.test(text) ||
    /\b(?:records?|documents?|paperwork|pdf|files?|account)\b|ملف|مستند|حساب/u.test(
      text,
    );
  if (!(personalRecordOwner(text) || family.test(text))) return false;
  return (
    record &&
    !/\b(?:book|request|make|schedule) (?:an? |a new )(?:appointment|visit|booking)\b|(?:احجز|قدم) (?:موعد|طلب) جديد/u.test(
      text,
    )
  );
}

const personalRecordOwner = (text) =>
  own.test(text) ||
  /\b(?:i|we)\s+(?:gave|left|provided|submitted|arranged|scheduled|attended|booked|requested|had)\b|(?:واخدها انا|حاجزها|حجزتها|مسجلها|وصلتني|وصلوني|عملتها|عملتو|اخدتها|قدمتها|عطيتكن|عطيتكم)(?!\p{L})/u.test(
    text,
  );

export function privateAccountIntent(message, category) {
  if (category && !["private", "cancel"].includes(category)) return;
  const text = canon(message);
  if (family.test(text)) return;
  if (category === "cancel")
    return /\b(?:reschedule|change|move)\b|تغيير|غير موعد/u.test(text)
      ? undefined
      : "cancel_request";
  if (!personalRecordOwner(text)) return;
  if (results.test(text))
    return /\b(?:where|which (?:section|tab|page)|how (?:do|can) i (?:find|access))\b|وين|اين|(?:باي|اي) (?:قسم|صفحه|خانه)/u.test(
      text,
    )
      ? "where_results"
      : "my_results";
  if (booking.test(text))
    return /\b(?:status|confirmed|approved|what happened)\b|شو صار|شو اخبار|حال[هة]|وضع|تاكد/u.test(
      text,
    )
      ? "booking_status"
      : "my_bookings";
}
