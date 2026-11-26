// Everyday demo requests that need no matcher. They run only after the
// protected gate has passed the message.
import {
  canon,
  cedarDomain,
  requestedProfessional,
} from "./public-assistant-language.js";
import { catalogueIntent, labBookingAnswer } from "./public-assistant-facts.js";
import { scheduleSpecialty } from "./public-assistant-routing.js";
import { resolveDay } from "./public-assistant-dates.js";
import { publicContent } from "./public-assistant-content.js";

// Answer in the language the question was written in.
export function questionLanguage(message, chosen) {
  if (/\p{Script=Arabic}/u.test(message)) return "ar";
  // Arabizi keeps the visitor's chosen language.
  if (/\p{L}[2356789]|[2356789]\p{L}{2}/u.test(message)) return chosen;
  return /\p{Script=Latin}/u.test(message) ? "en" : chosen;
}

const shorthand = {
  wat: "what",
  wen: "when",
  tym: "time",
  tme: "time",
  opn: "open",
  clos: "close",
  clse: "close",
  mondy: "monday",
  tusday: "tuesday",
  tuesdy: "tuesday",
  wensday: "wednesday",
  wednsday: "wednesday",
  thrsday: "thursday",
  thurday: "thursday",
  frdy: "friday",
  fridy: "friday",
  saterday: "saturday",
  satrday: "saturday",
};
export const expandShorthand = (message) =>
  message.replace(
    /\b(?:wat|wen|tym|tme|opn|clos|clse|mondy|tusday|tuesdy|wensday|wednsday|thrsday|thurday|frdy|fridy|saterday|satrday)\b/giu,
    (word) => shorthand[word.toLowerCase()],
  );

const topics = {
  en: [
    ["hours", "Hours"],
    ["doctor", "Find a doctor"],
    ["prices", "Prices"],
    ["preparation", "Preparation"],
    ["register", "Register"],
    ["about", "About Ask Cedar"],
  ],
  ar: [
    ["hours", "ساعات العمل"],
    ["doctor", "ابحث عن طبيب"],
    ["prices", "الأسعار"],
    ["preparation", "التحضير"],
    ["register", "تسجيل طلب"],
    ["about", "عن اسأل سيدر"],
  ],
};
export const topicMenu = (lang) =>
  topics[lang].map(([topic, label]) => ({ topic, label }));

export const clinicHoursNote = (message, lang) =>
  !/\bclinic\b|عياده/u.test(canon(message))
    ? ""
    : lang === "ar"
      ? "العيادة: يحضر كل طبيب في أوقات جلساته المنشورة. دوام المركز: "
      : "Clinic doctors attend at their own published session times. ";

export function registerAnswer(lang, message = "") {
  const text = canon(message);
  const clinic = publicContent.find(
    ({ id }) => id === "clinic-confirmation-" + lang,
  ).answer;
  const service = /\b(?:lab|laboratory)\b|مختبر/u.test(text)
    ? labBookingAnswer(lang).text
    : /\b(?:audiometry|hearing)\b|السمع/u.test(text)
      ? publicContent.find(({ id }) => id === "audiometry-booking-" + lang)
          .answer
      : "";
  return [clinic, service].filter(Boolean).join(" ");
}

const accountCue =
  /\b(?:sign(?:ing)? (?:in|up)|log ?in|(?:create|open|make|register) (?:an? )?(?:new )?account|new account)\b|حساب جديد|(?:اعمل|بعمل|انشاء|انشئ|افتح|بفتح) حساب|تسجيل الدخول|سجل الدخول/u;
const registerCue =
  /\bregist(?:er|ering|ration)\b|\bhow (?:can|do) i request (?:a |an )?(?:clinic )?(?:visit|appointment)\b|(?<!\p{L})(?:ب?سجل|اسجل|تسجيل|التسجيل)(?!\p{L})/u;
const meetCue =
  /\b(?:book\w*|appointment|see|visit|available|availability|when|schedule)\b|احجز|حجز|موعد|متي|امتي|ايمتي|متاح|موجود/u;

// Returns the kind of everyday request, or null for the usual routing.
export function everydayRequest(message, today) {
  const text = canon(message);
  if (accountCue.test(text)) return { kind: "account" };
  const date = resolveDay(message, today);
  if (registerCue.test(text))
    return { kind: "register", day: date.specified ? date.day : undefined };
  const clinician = requestedProfessional(message);
  if (
    clinician &&
    meetCue.test(text) &&
    !date.specified &&
    !/\bweek\b|اسبوع/u.test(text)
  )
    return { kind: "clinician", clinician };
  return null;
}

export const accountAnswer = {
  en: "Open My account, then choose Sign in, or Create account if you are new.",
  ar: "افتح حسابي ثم اختر تسجيل الدخول، أو إنشاء حساب إذا كنت جديدًا.",
};

// Anything that could be about Cedar, or a person needing someone, stays with
// Reception. Only the rest is called off-topic.
const aboutVisit =
  /\b(?:park\w*|building|insurance|referral|address|location|contact|reception|pay\w*|visit\w*|booking|staff|nurse|wheelchair|result\w*|report\w*|doctor|register\w*|account)\b|موقف|مبني|تامين|عنوان|استقبال|دفع|زياره|ممرض|نتيج|نتايج|حساب|ساعات|ساعه|مفتوح|مسكر|يفتح|يسكر|سعر|قديش|كلف|تحضير|صيام|صوم|اطبا|هاتف|رقم/u;
const needsPerson =
  /\b(?:help|awful|terrible|scared|afraid|worried|emergency|hurts?|pain|dizzy|bleed\w*|sick|ill|unwell|strange|feel\w*|fell|fall\w*|faint\w*|breath\w*|father|mother|dad|mum|mom|child|baby|son|daughter|husband|wife|friend|someone|somebody|happened|accident)\b|ساعدني|مساعده|خايف|تعبان|مريض|وجع|(?<!\p{L})(?:امي|ابي|ابني|بنتي|وقع|صار|حاسس|دايخ|نزيف)/u;

export function clearlyOffTopic(message) {
  const text = canon(message);
  return (
    !cedarDomain.test(text) &&
    !aboutVisit.test(text) &&
    !needsPerson.test(text) &&
    !catalogueIntent(message) &&
    !scheduleSpecialty(message) &&
    !requestedProfessional(message)
  );
}
