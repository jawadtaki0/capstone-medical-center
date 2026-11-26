import { specialtyDefinitions } from "../src/data/specialties.js";
import { validDate, addDays, shownDateFor } from "./public-assistant-dates.js";
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
