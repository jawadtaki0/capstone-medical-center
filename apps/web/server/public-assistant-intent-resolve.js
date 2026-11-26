// A matched intent only picks the published handler. The date, service, test,
// specialty and clinician must still come from the visitor's own words.
import {
  catalogueIntent,
  labBookingAnswer,
  unpublishedPrice,
} from "./public-assistant-facts.js";
import {
  canon,
  requestedProfessional,
  nameTokens,
  priceConcept,
} from "./public-assistant-language.js";
import {
  resolveBeirutDate,
  resolveTurnDates,
  sessionDays,
} from "./public-assistant-dates.js";
import { scheduleRequest } from "./public-assistant-routing.js";
import {
  audiometryPreparation,
  publicContent,
} from "./public-assistant-content.js";
import { bareClinic, singleRequest } from "./public-assistant-confidence.js";

const personal =
  /\b(?:for|with) (?:my|me|children|kids|an emergency|walk-ins?|a referral|insurance)\b/u;
const bookForMe =
  /\b(?:book|reserve|schedule) (?:me|that|the|it)\b|احجز لي|احجزلي/u;

// Dates the resolver cannot read. Answering them with today would be wrong.
const unsupportedDate =
  /\b(?:next (?:week|month|year)|last (?:week|month|year|mon|tues|wednes|thurs|fri|satur|sun)(?:day)?|(?:week|day) after|after next|ago|(?:in|after) (?:\w+ )?(?:weeks|months)|yesterday|mbere7|mbare7|holidays?|christmas|easter|eid|3id|ramadan)\b|(?:الاسبوع|الشهر) (?:الجاي|المقبل|القادم)|بعد الجاي|الماضي|الماضيه|اللي (?:فات|مضي)|مبارح|امبارح|عطله رسميه|(?<!\p{L})(?:ال)?عيد(?!\p{L})|رمضان/u;
// A month without a day number would resolve to the coming weekday instead.
const bareMonth =
  /^(?!.*\d).*\b(?:january|february|march|april|june|july|august|september|october|november|december)\b/su;
// Hours do not answer these, however similar the wording looks.
const notHours =
  /\b(?:park(?:ing)?|reports?|results?|director|manager)\b|موقف|باركينغ|نتيجه|نتايج|تقرير|مدير/u;
const unreadDate =
  /(?<![\p{L}\p{N}])\d{1,4}(?:st|nd|rd|th)?(?![\p{L}\p{N}])|\b(?:week|weekend|month|days?|date|night|nhar|yom|on the|mon|tues?|wed|thur?s?|fri|sat|ssebt|7ad|a7ad|jem3a|jom3a)\b|نهار|يوم|اسبوع|شهر|تاريخ|ليل/u;

const labWords =
  /\b(?:lab|laboratory|labortory|mokhtabar|moukhtabar|mo5tabar|blood draw)\b|مختبر|اللاب|(?<!\p{L})لاب(?!\p{L})/u;
const audioWords = /\b(?:audiometry|hearing|sama3)\b|السمع/u;
const centerWords =
  /\b(?:cent(?:er|re)|building|clinic|cedar|markaz|mabna|entrance|doors)\b|مركز|المبني|مبني|عياده|سيدر|بوابه المركز/u;
const clinicPolicy =
  /\bclinic\b.{0,45}\b(?:request|time|window|session)\b.{0,80}\b(?:confirm(?:ed|ation)?|reserve|book)\b/u;
const hoursCue =
  /\b(?:hrs|hours?|first and last|open\w*|clos\w*|shut\w*|tim(?:e|ing|etable)|when|until|late|early|arrive|visit\w*|enter|come|running|operat\w*|working|emta|aymta|2emta|se3a|sa3a|daw[ae]m|wa2e?t|awkat|aw2at|maftou?7a?|bye?fta7|byesakk?[ei]r|msakk?[ae]r|fate7a?|byebda2|bikhallas)\b|ساعه|ساعات|وقت|دو+ام|متي|امتي|ايمتي|فاتح|مفتوح|يفتح|بتفتح|بيفتح|يسكر|مسكر|سكر|شغال|يغلق|بيقفل|يستقبل|بيستقبل|بيبلش/u;
const priceCue =
  /\b(?:fees?|prices?|costs?|charges?|how much|set me back|mablagh|se3er|s3er|kelfe|taklfe|2adesh|2addesh|ade|adde|addesh)\b|سعر|كلف|رسوم|قديش|قدي|الحق|مبلغ|بكم/u;
const priceSubject =
  /\b(?:lab(?:oratory)?|clinic|consultation|appointment|visit|audiometry|hearing|tests?|mokhtabar|sama3|fa7s|ta7lil)\b|المختبر|العياده|كشفيه|معاينه|السمع|فحص|تحليل/u;
const labSubject =
  /\b(?:lab(?:oratory)?|mokhtabar|blood|urine|panel|ta7lil)\b|مختبر|تحليل|الدم|البول/u;
const preparationCue =
  /\b(?:prepar\w*|ready|fast\w*|eat\w*|drink\w*|avoid|before|ahead|collect\w*|sample|container|specimen|bring|siyam|soum|sawm|2abel|abel|ta7dir|te7dir|jahhez|3elbe)\b|تحضير|حضر|جهز|صيام|صوم|اكل|اشرب|قبل|عينه|جمع|وعاء|علبه/u;
const bookingCue =
  /\b(?:book\w*|reserv\w*|appointment|slot|online|confirm\w*|request|website|site|arrange|7aj[ez]\w*|e7je?z|2akked|ouzkor)\b|حجز|احجز|موعد|طلب|تاكيد|ياكد|اكد|يثبت|موكد|اونلاين|الموقع/u;
const clinicWords = /\b(?:clinic|doctor|3iyade)\b|عياده|دكتور|طبيب/u;

// Commas and semicolons join one request unless two clauses each ask something.
const asks =
  /^(?:and )?(?:is|are|am|can|could|will|should|must|may|tell|show|give|list|check|find)\b|\b(?:what|when|which|who|where|how|do i|does|is there|until|shu|emta|aymta|kif|ade|addesh|2adesh|hal|fiye|wen|aya)\b|(?<!\p{L})و?(?:شو|متي|امتي|ايمتي|كيف|قديش|قديه|بكم|كم|هل|وين|مين|فيني|في)(?!\p{L})/u;
const greeting =
  /^(?:hi|hello|hey|please|thanks|thank you|good (?:morning|afternoon|evening)|marhaba|salam|مرحبا|سلام|لو سمحت|من فضلك|صباح الخير|مسا الخير)$/u;
const topicCues = [
  hoursCue,
  priceCue,
  preparationCue,
  bookingCue,
  priceSubject,
  labWords,
  audioWords,
  centerWords,
  clinicWords,
];
const aboutCedar = (clause) => topicCues.some((cue) => cue.test(clause));

function requestText(message, date) {
  const clauses = canon(message.replace(/(\d{1,2}),\s+(?=\d{4}\b)/gu, "$1 "))
    .split(/[,،;؛]+/u)
    .map((clause) => clause.replace(/[.!?؟\s]+$/u, "").trim())
    .filter(Boolean);
  if (clauses.length > 1) {
    const questions = clauses.filter(
      (clause) => asks.test(clause) && aboutCedar(clause),
    );
    const related = (clause) =>
      greeting.test(clause) ||
      aboutCedar(clause) ||
      Boolean(catalogueIntent(clause)) ||
      resolveBeirutDate(clause, date).specified;
    if (questions.length > 1 || !clauses.every(related)) return "";
  }
  return singleRequest(message.replace(/[,،;؛]+/gu, " "));
}

const reference = (route, fields) => ({ kind: "reference", route, fields });
const reviewed = (id, lang) =>
  publicContent.find((record) => record.id === id + "-" + lang).answer;

export const medicationQuestion = (value) =>
  /\b(?:medication|medicine|pills?|drug|antibiotic|dose|dosage|painkiller|take|stop taking)\b|جرعه|الدوا|ادويه|دواء|مضاد|مسكن/u.test(
    canon(value),
  );

export function isNamedTestPreparation(value) {
  const text = canon(value);
  return (
    /\b(?:preparation|prep|collection|fasting|fast|specimen|container)\b|تحضير|صيام|صوم|جمع|وعاء/u.test(
      text,
    ) &&
    !/\b(?:your|system|developer|hidden|internal|override|ignore|private|dose|medication|medicine)\b|تعليماتك|السريه|الداخليه|تجاهل|جرعه|الادويه/u.test(
      text,
    ) &&
    catalogueIntent(value)?.tests.length === 1
  );
}

export function demoReferenceIntent(value) {
  const text = canon(value);
  if (
    /\b(?:register|registration|steps? to submit|steps? (?:are )?published to register)\b|خطوات التسجيل|خطوات تقديم|تسجيل (?:طلب|زياره)|بسجل/u.test(
      text,
    ) &&
    clinicWords.test(text)
  )
    return "registration";
  if (
    /\b(?:turnaround|how long|when|released|published time)\b|(?:وقت|مده|صدور|ايمتي|امتي|قديش|كم يوم)/u.test(
      text,
    ) &&
    /\b(?:results?|reports?)\b|نتيج|نتايج|تقارير/u.test(text) &&
    !/\bmy\b|نتيجتي/u.test(text)
  )
    return "resultsTiming";
  return null;
}

function unavailableDate(intent, filters) {
  return { kind: "unavailableDate", intent, filters };
}

function hoursRequest(
  intent,
  message,
  text,
  { date, context, demo, selectedDate },
  picked,
) {
  if (
    (!hoursCue.test(text) && !(demo && /\b(?:lock up|desk)\b/u.test(text))) ||
    notHours.test(text)
  )
    return null;
  let services = [
    labWords.test(text) && "labHours",
    audioWords.test(text) && "audioHours",
  ].filter(Boolean);
  if (!services.length && centerWords.test(text)) services = ["centerHours"];
  // A visitor's own choice may name the service; a similarity score may not.
  if (!services.length && picked) services = [intent];
  if (!services.includes(intent)) return null;
  const center = services.includes("centerHours");
  const hours = {
    center,
    lab: services.includes("labHours"),
    audio: services.includes("audioHours"),
    weekend: center && /\bweekend\b|عطله نهايه الاسبوع/u.test(text),
  };
  if (selectedDate)
    return {
      kind: "hours",
      hours,
      hourDays: [selectedDate],
      hoursMessage: message,
    };
  const day = resolveBeirutDate(message, date, context);
  if (
    demo &&
    (unsupportedDate.test(text) ||
      bareMonth.test(text) ||
      (day.specified && !day.day))
  )
    return unavailableDate(intent);
  if (!hours.weekend && !day.specified && unreadDate.test(text))
    return demo ? unavailableDate(intent) : null;
  const { hourDays, conflict } = resolveTurnDates(
    message,
    message,
    hours,
    false,
    date,
    context,
  );
  if (
    demo &&
    hourDays.some((day) => !sessionDays({ from: day, through: day }, date))
  )
    return unavailableDate(intent);
  return conflict
    ? demo
      ? unavailableDate(intent)
      : null
    : { kind: "hours", hours, hourDays, hoursMessage: message };
}

function sessionRequest(message, text, { date, context, demo, selectedDate }) {
  const {
    day,
    specified,
    specialty,
    clinician: parsedClinician,
    time,
  } = scheduleRequest(message, date, resolveBeirutDate(message, date, context));
  const clinician =
    parsedClinician || (demo && requestedProfessional(message)) || undefined;
  const named = clinician
    ? nameTokens(clinician).length >= (demo ? 1 : 2)
    : specialty || bareClinic.test(text);
  if (!named) return null;
  if (
    demo &&
    !selectedDate &&
    (specified || unsupportedDate.test(text) || bareMonth.test(text)) &&
    (!day ||
      !sessionDays({ from: day, through: day }, date) ||
      unsupportedDate.test(text) ||
      bareMonth.test(text))
  )
    return unavailableDate("clinicSchedule", {
      professional: clinician,
      specialty,
    });
  if (!day && !selectedDate && !demo) return null;
  return {
    kind: "sessions",
    day: selectedDate ?? day,
    specialtyHint: specialty,
    namedProfessional: clinician,
    time,
    hasTime: Object.keys(time).length > 0,
    directSearch: true,
    fixedSearch: true,
    maySearch: true,
    knownSearch: true,
  };
}

function priceRequest(message, text, lang) {
  const tests = catalogueIntent(message);
  if (!(priceConcept(message) || priceCue.test(text))) return null;
  if (!tests && !priceSubject.test(text)) return null;
  const lab = !audioWords.test(text) && (tests || labSubject.test(text));
  return reference("reception", unpublishedPrice(lang, Boolean(lab)));
}

function preparationRequest(message, text, lang) {
  if (!preparationCue.test(text)) return null;
  const lab = catalogueIntent(message);
  if (lab?.tests.length === 1)
    return {
      kind: "labs",
      lab: { kind: "labs", tests: lab.tests, preparation: true },
    };
  if (!lab && audioWords.test(text))
    return reference("library", {
      text: audiometryPreparation(lang),
      page: "/services/audiometry",
      reception: true,
    });
  return null;
}

function bookingRequest(text, lang) {
  if (!bookingCue.test(text) && !/\bappointments?\b/u.test(text)) return null;
  const audio = audioWords.test(text);
  const lab = labWords.test(text);
  if (audio && lab) return null;
  if (audio)
    return reference("library", {
      text: reviewed("audiometry-booking", lang).replace(
        "Contact reception",
        "Contact Reception",
      ),
      page: "/services/audiometry",
      reception: true,
    });
  if (lab) return reference("library", labBookingAnswer(lang));
  if (!clinicWords.test(text)) return null;
  return reference("library", {
    text: reviewed("clinic-confirmation", lang),
    page: "/services/clinic",
  });
}

const clearClinicRequest =
  /\b(?:windows?|slots?|sessions?|appointments?|availability|available|roster|visits?|schedule|listed|published)\b|جلس|مواعيد|موعد|وقت|الفتره|جدول|منشور|متاح|(?:فيني|بدي) شوف/u;
const hoursRequestCue =
  /\b(?:hours?|hrs|open\w*|clos\w*|first and last|timetable|timings?)\b|دو+ام|ساعات|وقت فتح|بتفتح|افتح|يفتح|بيفتح|سكر/u;

export function exactDemoPublicRequest(message, turn) {
  const text = canon(message);
  if (demoReferenceIntent(message)) return null;
  if (clinicPolicy.test(text))
    return resolvePublicIntent("bookingPolicy", message, turn);
  if (
    clearClinicRequest.test(text) &&
    !/\b(?:lab|audiometry|test|hearing|result)\b|مختبر|فحوص|نتيج|السمع/u.test(
      text,
    )
  ) {
    const clinic = resolvePublicIntent("clinicSchedule", message, turn);
    if (
      clinic &&
      (clinic.namedProfessional ||
        clinic.specialtyHint ||
        clinic.filters?.professional ||
        clinic.filters?.specialty ||
        bareClinic.test(text))
    )
      return clinic;
  }
  if (hoursRequestCue.test(text)) {
    const candidates = ["centerHours", "labHours", "audioHours"]
      .map((intent) => resolvePublicIntent(intent, message, turn))
      .filter(Boolean);
    if (candidates.length === 1) return candidates[0];
  }
  const lab = catalogueIntent(message);
  if (lab?.tests.length === 1) {
    if (priceCue.test(text) || priceConcept(text))
      return resolvePublicIntent("prices", message, turn);
    if (preparationCue.test(text))
      return resolvePublicIntent("preparation", message, turn);
  }
  return null;
}

// Returns the published request the visitor asked for, or null for Reception.
export function resolvePublicIntent(intent, message, turn, picked = false) {
  const original = canon(message);
  if (turn.demo && intent === "bookingPolicy" && clinicPolicy.test(original))
    return bookingRequest(original, turn.lang);
  const normalized = turn.demo
    ? message.replace(
        /\b(?:opening and closing|first and last)\b/giu,
        "opening closing",
      )
    : message;
  const text = requestText(normalized, turn.date);
  if (
    !text ||
    personal.test(text) ||
    bookForMe.test(text) ||
    (!turn.demo &&
      (unsupportedDate.test(canon(message)) || bareMonth.test(canon(message))))
  )
    return null;
  switch (intent) {
    case "registration":
      return turn.demo && demoReferenceIntent(message) === "registration"
        ? reference("library", {
            text: reviewed("clinic-confirmation", turn.lang),
            page: "/services/clinic",
          })
        : null;
    case "resultsTiming":
      return null;
    case "centerHours":
    case "labHours":
    case "audioHours":
      return hoursRequest(intent, message, text, turn, picked);
    case "clinicSchedule":
      return sessionRequest(message, text, turn);
    case "prices":
      return priceRequest(message, text, turn.lang);
    case "preparation":
      return preparationRequest(message, text, turn.lang);
    case "bookingPolicy":
      return bookingRequest(text, turn.lang);
    default:
      return null;
  }
}
