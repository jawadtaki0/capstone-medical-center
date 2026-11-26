import { specialtyDefinitions } from "../src/data/specialties.js";
import { laboratoryTests } from "../src/data/labAudioContent.js";
import { fixedDemoIntent } from "./public-assistant-demo.js";
import {
  everydayRequest,
  expandShorthand,
} from "./public-assistant-demo-turns.js";
import {
  exactDemoPublicRequest,
  isNamedTestPreparation,
  resolvePublicIntent,
} from "./public-assistant-intent-resolve.js";
import {
  canon,
  clinicalConcept,
  nameScore,
} from "./public-assistant-language.js";
import {
  containsPrivateAccountText,
  privateAccountIntent,
} from "./public-assistant-account.js";
import { protectedGate } from "./public-assistant-gate.js";
import { isExactPublicPreparation } from "./public-assistant-confidence.js";
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
const testIds = new Set(laboratoryTests.map((test) => test.id));
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
  if (value && Object.hasOwn(value, "intent")) {
    const date = value.date === null || validDate(value.date);
    const service = services.has(value.service) && value.service !== "clinic";
    switch (value.intent) {
      case "hours":
        return keys(value, ["intent", "service", "date"]) && service && date;
      case "schedule":
        return (
          keys(value, ["intent", "date", "specialty", "clinicianId"]) &&
          date &&
          (value.specialty === null || specialties.has(value.specialty)) &&
          (value.clinicianId === null ||
            (typeof value.clinicianId === "string" &&
              identifier.test(value.clinicianId)))
        );
      case "bookingPolicy":
        return (
          keys(value, ["intent", "service"]) &&
          ["clinic", "laboratory", "audiometry"].includes(value.service)
        );
      case "identity":
      case "creator":
      case "offTopic":
        return keys(value, ["intent"]);
      default:
        return false;
    }
  }
  if (!keys(value, ["topic", "menu", "action", "date"])) return false;
  if (Object.hasOwn(value, "topic"))
    return Object.keys(value).length === 1 && Boolean(guidedTopic(value.topic));
  if (Object.hasOwn(value, "menu"))
    return (
      Object.keys(value).length === 1 &&
      keys(value.menu, ["topic", "choice", "date"]) &&
      topics.has(value.menu.topic) &&
      (value.menu.choice === undefined ||
        (value.menu.topic === "hours" &&
          ["center", "lab", "audio"].includes(value.menu.choice)) ||
        (value.menu.topic === "doctor" && specialties.has(value.menu.choice)) ||
        (["preparation", "prices"].includes(value.menu.topic) &&
          (testIds.has(value.menu.choice) ||
            value.menu.choice === "audiometry" ||
            (value.menu.topic === "prices" &&
              value.menu.choice === "clinic")))) &&
      (value.menu.date === undefined || validDate(value.menu.date))
    );
  return (
    keys(value, ["action", "date"]) &&
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
      /\s+(?:instead|as well|too|please|لو سمحت|شو الوضع|شو الدوام|كيف بيكون الدوام|كيف الدوام)$/u,
      "",
    )
    .trim()
    .replace(/^و(?=ال)/u, "");
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

// Questions answered in the browser, so their text is never sent.
export function localRoute(message) {
  const detected = protectedGate(message);
  const sensitive = containsPrivateAccountText(message);
  const category =
    detected === "clinical" &&
    (isExactPublicPreparation(message) || isNamedTestPreparation(message))
      ? null
      : detected;
  // Medication advice that mentions an appointment or result is still clinical.
  if (["private", "clinical"].includes(category) && clinicalConcept(message))
    return { category: "clinical", intent: null };
  const intent = privateAccountIntent(message, category);
  if (
    !intent &&
    !sensitive &&
    !["private", "cancel", "clinical", "emergency"].includes(category)
  )
    return null;
  return {
    category,
    intent:
      intent ??
      (sensitive || category === "private" || category === "cancel"
        ? "sign_in"
        : null),
  };
}

export function browserPublicRequest(input, previous, today, published = []) {
  const message = expandShorthand(input).replace(
    /\bstart and finish\b/iu,
    "open close",
  );
  const context = { shownDate: previous?.date };
  const follow = resolvePublicFollowup(
    message,
    usablePublicContext(previous, today),
    today,
  );
  if (follow)
    return follow.service === "clinic"
      ? {
          intent: "schedule",
          date: follow.date,
          specialty: previous.specialty,
          clinicianId: previous.clinicianId,
        }
      : { intent: "hours", ...follow };

  const fixed = fixedDemoIntent(message, null);
  if (fixed) return { intent: fixed };
  const turn = { date: today, context, demo: true, lang: "en" };
  const request = exactDemoPublicRequest(message, turn);
  const servicesById = {
    centerHours: "center",
    labHours: "laboratory",
    audioHours: "audiometry",
  };
  if (request?.kind === "hours") {
    const names = [
      ["center", "center"],
      ["lab", "laboratory"],
      ["audio", "audiometry"],
    ].filter(([key]) => request.hours[key]);
    if (names.length === 1 && request.hourDays.length === 1)
      return {
        intent: "hours",
        service: names[0][1],
        date: request.hourDays[0],
      };
  }
  if (servicesById[request?.intent])
    return {
      intent: "hours",
      service: servicesById[request.intent],
      date: null,
    };

  const everyday = everydayRequest(message, today);
  if (
    request?.kind === "sessions" ||
    request?.intent === "clinicSchedule" ||
    everyday?.kind === "clinician"
  ) {
    const named =
      request?.namedProfessional ??
      request?.filters?.professional ??
      everyday?.clinician;
    const specialty = request?.specialtyHint ?? request?.filters?.specialty;
    const date =
      request?.day ?? (request?.intent === "clinicSchedule" ? null : today);
    let clinicianId = null;
    if (named) {
      const scores = published.map((row) => ({
        id: row.professionalId,
        score: nameScore(named, row.professionalName, { strict: true }),
      }));
      const best = Math.max(0, ...scores.map((row) => row.score));
      const matches = [
        ...new Set(
          scores
            .filter((row) => row.score && row.score === best)
            .map((row) => row.id),
        ),
      ];
      if (matches.length !== 1 || !identifier.test(matches[0])) return null;
      clinicianId = matches[0];
    }
    const result = {
      intent: "schedule",
      date,
      specialty: specialties.has(specialty) ? specialty : null,
      clinicianId,
    };
    return validCurrentMessage(result) ? result : null;
  }
  if (everyday?.kind === "register")
    return {
      menu: {
        topic: "register",
        ...(everyday.day ? { date: everyday.day } : {}),
      },
    };
  if (
    request?.kind === "labs" &&
    testIds.has(request.lab.tests[0].id ?? request.lab.tests[0])
  )
    return {
      menu: {
        topic: "preparation",
        choice: request.lab.tests[0].id ?? request.lab.tests[0],
      },
    };
  const policy = resolvePublicIntent("bookingPolicy", message, turn);
  if (
    policy &&
    /\b(?:online|book\w*|confirm\w*|reserve|website)\b|حجز|تاكيد|الموقع/u.test(
      canon(message),
    )
  ) {
    const service = {
      "/services/audiometry": "audiometry",
      "/services/clinic": "clinic",
      "/services/laboratory": "laboratory",
    }[policy.fields.page];
    if (service) return { intent: "bookingPolicy", service };
  }
  if (resolvePublicIntent("prices", message, turn))
    return { menu: { topic: "prices" } };
  if (resolvePublicIntent("preparation", message, turn)?.kind === "reference")
    return { menu: { topic: "preparation", choice: "audiometry" } };
  return null;
}
