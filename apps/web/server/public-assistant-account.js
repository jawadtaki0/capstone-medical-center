import { canon } from "./public-assistant-language.js";

export const cancelChatCopy = {
  en: "To cancel, open My account and choose the booking, or use your guest cancellation link. You’ll review and confirm the cancellation before it takes effect. Contact Cedar Reception if you need help.",
  ar: "لإلغاء موعد، افتح حسابي واختر الموعد، أو استخدم رابط إلغاء موعد الضيف. راجع تفاصيل الإلغاء وأكّده ليصبح نافذًا. تواصل مع استقبال سيدر إذا احتجت إلى المساعدة.",
};

export function privateAccountIntent(message, category) {
  if (category && !["private", "cancel"].includes(category)) return;
  const text = canon(message);
  if (
    /\b(?:mom|mother|father|dad|wife|husband|sister|brother|aunt|uncle|cousin|friend|patient|someone else|their|his|her)\b|(?:امي|والدتي|ابي|والدي|اخي|اختي|زوجتي|خالتي|عمتي|صديقي)/u.test(
      text,
    )
  )
    return;
  if (category === "cancel")
    return /\b(?:reschedule|change|move)\b|تغيير|غير موعد/u.test(text)
      ? undefined
      : "cancel_request";
  const results = /\b(?:results?|reports?)\b|نتايج|نتائج|نتيج|تقريري/u.test(
    text,
  );
  const own =
    /\bmy\b|نتايجي|نتائجي|نتيجتي|تقريري|موعدي|حجزي|مواعيدي|حجوزاتي|ابني|بنتي|طفلي/u.test(
      text,
    );
  if (results && own)
    return /\b(?:where|how (?:do|can) i (?:find|access))\b|وين|اين/u.test(text)
      ? "where_results"
      : "my_results";
  if (
    own &&
    /\b(?:bookings?|appointments?|requests?)\b|موعد|مواعيد|حجز|طلباتي/u.test(
      text,
    )
  )
    return /\b(?:status|confirmed|approved|what happened)\b|شو صار|حال[هة]|تاكد/u.test(
      text,
    )
      ? "booking_status"
      : "my_bookings";
}
