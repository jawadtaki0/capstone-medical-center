import { specialtyDefinitions } from "../src/data/specialties.js";
import { canon } from "./public-assistant-language.js";
import {
  validDate,
  addDays,
  shownDateFor,
  resolveBeirutDate,
} from "./public-assistant-dates.js";
import { guidedTopic } from "./public-assistant-gate.js";

const services = new Set(["center", "laboratory", "audiometry", "clinic"]);
const topics = new Set([
  "hours",
  "doctor",
  "preparation",
  "prices",
  "register",
  "about",
]);
const specialties = new Set(
  specialtyDefinitions.map((item) => item.name ?? item.label),
);
const identifier = /^(?:doctor|specialist):[a-z0-9][a-z0-9_-]{0,90}$/iu;
const keys = (value, allowed) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).every((key) => allowed.includes(key));

export function validPublicContext(value) {
  if (value === null) return true;
  const fields = ["lastIntent", "service", "date", "specialty", "clinicianId"];
  return Boolean(
    keys(value, fields) &&
      Object.keys(value).length === fields.length &&
      (value.lastIntent === "hours"
        ? services.has(value.service) && value.service !== "clinic"
        : value.lastIntent === "schedule" && value.service === "clinic") &&
      (value.date === null || validDate(value.date)) &&
      (value.specialty === null ||
        (value.lastIntent === "schedule" &&
          specialties.has(value.specialty))) &&
      (value.clinicianId === null ||
        (value.lastIntent === "schedule" &&
          typeof value.clinicianId === "string" &&
          identifier.test(value.clinicianId))),
  );
}

export function validCurrentMessage(value) {
  if (typeof value === "string")
    return value.trim().length > 0 && value.length <= 400;
  if (!keys(value, ["topic", "menu", "action", "date"])) return false;
  if (Object.hasOwn(value, "topic"))
    return Object.keys(value).length === 1 && Boolean(guidedTopic(value.topic));
  if (Object.hasOwn(value, "menu"))
    return (
      Object.keys(value).length === 1 &&
      keys(value.menu, ["topic", "choice", "date"]) &&
      topics.has(value.menu.topic) &&
      (value.menu.choice === undefined ||
        (typeof value.menu.choice === "string" &&
          value.menu.choice.length <= 80 &&
          (/^[a-z0-9][a-z0-9_-]*$/iu.test(value.menu.choice) ||
            specialties.has(value.menu.choice)))) &&
      (value.menu.date === undefined || validDate(value.menu.date))
    );
  return (
    typeof value.action === "string" &&
    /^[\w-]{1,3500}\.[\w-]{43}$/u.test(value.action) &&
    (value.date === undefined || validDate(value.date))
  );
}

export function usablePublicContext(context, today) {
  if (!context || !validPublicContext(context)) return null;
  if (
    context.date &&
    (context.date < today || context.date > addDays(today, 6))
  )
    return null;
  return context;
}

export function publicReplyContext(reply, service, relativeDate) {
  const date = shownDateFor(reply, relativeDate);
  if (reply.kind === "sessions" && reply.cards?.length) {
    const unique = (values) => (new Set(values).size === 1 ? values[0] : null);
    const specialty = unique(reply.cards.map((card) => card.specialty));
    const clinicianId = unique(
      reply.cards.map((card) =>
        card.href?.startsWith("/request?")
          ? new URLSearchParams(card.href.slice(9)).get("professional")
          : null,
      ),
    );
    return {
      lastIntent: "schedule",
      service: "clinic",
      date,
      specialty: specialties.has(specialty) ? specialty : null,
      clinicianId:
        clinicianId && identifier.test(clinicianId) ? clinicianId : null,
    };
  }
  if (
    reply.kind === "library" &&
    service &&
    services.has(service) &&
    service !== "clinic"
  )
    return {
      lastIntent: "hours",
      service,
      date,
      specialty: null,
      clinicianId: null,
    };
  return null;
}

const weekdays =
  /^(?:(?:on|for) )?(?:today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{4}-\d{2}-\d{2}|(?:(?:the|that) )?(?:same )?(?:day|date))$|^(?:(?:نهار|يوم) )?(?:اليوم|بكرا|الاحد|الاثنين|الثلاثاء|الاربعاء|الخميس|الجمعه|السبت|بهالنهار|بنفس النهار|بهداك النهار)$/u;
const serviceNames = [
  ["laboratory", /\b(?:lab|laboratory)\b|(?<!\p{L})ب?المختبر(?!\p{L})/gu],
  [
    "audiometry",
    /\b(?:audiometry|hearing tests?)\b|(?<!\p{L})(?:فحوصات السمع|قياس السمع)(?!\p{L})/gu,
  ],
  [
    "center",
    /\b(?:center|centre|clinic)\b|(?<!\p{L})ب?(?:المركز|العياده)(?!\p{L})/gu,
  ],
];

export function resolvePublicFollowup(message, previous, today) {
  if (!previous) return null;
  // Remove conversational framing; the remainder must be a day or service,
  // so a date mentioned inside an unrelated request cannot trigger a lookup.
  let query = canon(message)
    .replace(/[؟?!.,]+$/gu, "")
    .trim()
    .replace(
      /^(?:(?:could|can) (?:you|we) (?:check|make it)|how about|what about|and|طيب|وكمان|كمان|وعندن)\s+|^و(?=(?:نهار|يوم|ال))/u,
      "",
    )
    .replace(/\s+(?:instead of|rather than|بدل)\s+.*$/u, "")
    .replace(
      /\s+(?:instead|as well|too|please|لو سمحت|شو الوضع|كيف بيكون الدوام|كيف الدوام)$/u,
      "",
    )
    .trim();
  const serviceMatches = serviceNames.filter(
    ([, pattern]) => query.replace(pattern, "") !== query,
  );
  if (serviceMatches.length > 1) return null;
  const [service, pattern] = serviceMatches[0] ?? [];
  if (pattern) {
    query = query
      .replace(pattern, "")
      .replace(/^(?:the )?|\b(?:hours|دوام)\b/gu, "")
      .replace(/^\s*(?:for|on)\s*$/u, "")
      .trim();
  }
  if ((!service && !query) || (query && !weekdays.test(query))) return null;
  const date = query
    ? resolveBeirutDate(query, today, { shownDate: previous.date }).day
    : previous.date;
  if (!date) return null;
  return { date, service: service ?? previous.service };
}
