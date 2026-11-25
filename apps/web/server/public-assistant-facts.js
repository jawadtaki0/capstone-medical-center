import {
  laboratoryTests,
  audiometryFaqs,
} from "../src/data/labAudioContent.js";
import { publicContent } from "./public-assistant-content.js";
import {
  availabilityQuestion,
  relativeDay,
  scheduleSpecialty,
  serviceLogistics,
} from "./public-assistant-routing.js";

const normalize = (value) =>
  value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
const words = (value) =>
  " " +
  normalize(value)
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim() +
  " ";
const timeRange = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export function catalogueIntent(message) {
  const query = words(message);
  const preparationQuery = query.replace(
    /\bfasting (?:blood )?(?:glucose|sugar)\b/g,
    " ",
  );
  const prep =
    /\b(?:prep(?:are|aration)?|fast(?:ing)?|abel|before)\b|تحضير|صيام/u.test(
      preparationQuery,
    );
  const ids = laboratoryTests
    .filter(({ id, name, aliases }) =>
      [id, name, name.replace(/\s*\(.*\)/, ""), ...aliases].some((term) =>
        query.includes(words(term)),
      ),
    )
    .map(({ id }) => id);
  if (/\bthyroid\b/.test(query) && /\biron\b/.test(query))
    return { kind: "labs", tests: ["tsh", "free-t4", "ferritin"] };
  if (ids.length && ids.length <= 3 && (prep || ids.length === 1))
    return {
      kind: "labs",
      tests: ids,
      preparation: prep,
      description:
        /\b(?:measure|detect|what (?:is|does)|purpose)\b|ماذا يقيس|ما هو/u.test(
          query,
        ),
      compare: ids.length > 1,
    };
  return null;
}

export function publicServiceAnswer(value, language) {
  const text = normalize(value);
  const library = (text, page, reception = false) => ({
    text,
    page,
    reception,
  });
  if (
    /\b(?:how (?:do|can) i|how to)\s+(?:request|book)\s+(?:an?\s+)?(?:clinic|consultation)\s+(?:session|visit|appointment)\b/u.test(
      text,
    )
  )
    return library(
      "Choose a published Clinic attendance window and submit a request. Choosing a session does not reserve an appointment. Reception confirms requests.",
      "/services/clinic",
    );
  if (
    /\b(?:submit(?:ting)?|send(?:ing)?)\b.{0,36}\b(?:clinic|request) form\b.{0,30}\bconfirm\b/u.test(
      text,
    )
  )
    return library(publicContent[0].answer, "/services/clinic");
  if (
    /\b(?:where (?:are you|is cedar) located|what(?:'s| is) (?:your|cedar's) address)\b|اين يقع/u.test(
      text,
    )
  )
    return library(
      language === "ar"
        ? "مركز سيدر في برج البراجنة، بيروت، قرب مكتبة نور الدين."
        : "Cedar is in Bourj El Brajneh, Beirut, near Noureddine Bookshop.",
      "/#contact",
    );
  if (
    /\b(?:your|cedar's|reception'?s?) (?:phone|telephone)(?: number)?\b|رقم الهاتف/u.test(
      text,
    )
  )
    return library(
      language === "ar"
        ? "رقم الهاتف المنشور لمركز سيدر هو +961 81 814 554."
        : "Cedar’s published phone number is +961 81 814 554.",
      "/#contact",
    );
  if (
    serviceLogistics(value) ||
    /\b(?:can i |how (?:do|can) i )?book a lab(?:oratory)? visit online\b/u.test(
      text,
    )
  )
    return library(
      "Online Lab booking is not available. Contact Reception first to confirm test availability and Lab hours. Cedar has not published whether your visit needs an appointment, a referral, or specific documents.",
      "/services/laboratory",
      true,
    );
  if (/\bhearing test.*(?:prep(?:aration)?|prepare)\b/u.test(text))
    return library(audiometryFaqs[1][1], "/services/audiometry", true);
  if (
    /\banything cheaper\b|\b(?:price|cost|cheaper)\b.*\b(?:panel|test)\b|\b(?:panel|tests?)\b.{0,35}\b(?:cost|price|charge)\b/u.test(
      text,
    )
  )
    return {
      ...library(
        "Cedar has not published prices for these tests. Contact Reception to ask about costs.",
        "/services/laboratory",
        true,
      ),
      kind: "reception",
    };
  if (
    /\bwhat the laboratory offers\b|\bwhat does the lab(?:oratory)? offer\b/u.test(
      text,
    )
  )
    return library(
      "Cedar’s Laboratory page lists blood, urine and stool tests with general preparation information. Contact Reception to confirm a test’s availability and instructions for your order.",
      "/services/laboratory",
      true,
    );
  if (/\b(?:summari[sz]e|overview of)\b.*\bwhat cedar offers\b/u.test(text))
    return library(
      "Cedar publishes Clinic attendance windows and accepts requests that Reception confirms. The Laboratory publishes a test catalogue and general preparation information. The Audiometry page describes hearing and middle-ear tests.",
      "/",
    );
  if (
    /\b(?:unhappy|concerned|complaint)\b.*\b(?:wait(?:ed|ing)?|visit|service)\b/u.test(
      text,
    )
  )
    return library(
      "I’m sorry the wait was frustrating. Contact Reception to discuss what happened. Cedar has not published a separate complaint process.",
      "/#contact",
      true,
    );
  if (/اطلب جلسة.*العيادة|طلب جلسة.*العيادة/u.test(text))
    return library(
      "اختر جلسة منشورة للعيادة، ثم افتح نموذج الطلب وأرسل طلبك. يتولى الاستقبال تأكيد الطلب.",
      "/services/clinic",
    );
  if (/النغمات النقية/u.test(text) && /طبلة الاذن/u.test(text))
    return library(
      publicContent
        .filter(({ id }) =>
          ["audiometry-pure-tone-ar", "audiometry-tympanometry-ar"].includes(
            id,
          ),
        )
        .map(({ answer }) => answer)
        .join(" "),
      "/services/audiometry",
    );
  return null;
}

const closingQuestion =
  /\b(?:close|closes|closing|(?:b(?:ye?|y)?|y)?s[ae]kk[ei]r)\b|يغلق|يسكر/iu;

export function hoursQuestion(value) {
  const text = normalize(value);
  const lab =
    /\b(?:lab(?:oratory)?|blood test|mokhtabar|moukhtabar)\b|مختبر/u.test(text);
  const audio = /\b(?:audiometry|hearing tests?)\b|فحص السمع/u.test(text);
  const clinic = /\bclinic\b|العيادة/u.test(text);
  const when =
    /\b(?:hours|open(?:ing)?|clos(?:e|es|ing)|until when|weekend|tomorrow|bukra|bokra|saturday|plan.*morning|byesakkir|byesakker|bysakkir)\b|يفتح|يغلق|ساعات|السبت|بكرا/u.test(
      text,
    );
  if (!when && !closingQuestion.test(text) && !(lab && audio)) return null;
  if (lab || audio) return { lab, audio, center: clinic, weekend: false };
  if (
    /\bopening hours\b|\bopen this weekend\b|\b(?:centre|center|cedar)\b.{0,15}\bopen\b|ساعات (?:عمل )?المركز/u.test(
      text,
    )
  )
    return { center: true, weekend: /weekend/.test(text) };
  return null;
}

export function combinedRequestParts(message) {
  const clauses = message.split(/(?:,\s*)?\band\b|[?؟;؛]\s*|،\s*و?/iu);
  const session = clauses.findIndex(
    (part) => scheduleSpecialty(part) && availabilityQuestion(part),
  );
  const hours = clauses.findIndex((part) => hoursQuestion(part));
  if (session < 0 || hours < 0 || session === hours) return null;
  return {
    session: clauses[session],
    hours: clauses[hours],
    hoursFirst: hours < session,
  };
}

export async function publishedHourAnswer(
  question,
  message,
  date,
  language,
  readHours,
  deadline,
  defaultDay = date,
) {
  const comparison = /\b(?:earlier|later)\b/i.test(message)
    ? message.match(
        /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi,
      )
    : null;
  const days = question.weekend
    ? ["Saturday", "Sunday"].map((day) => relativeDay(day, date))
    : comparison?.length === 2
      ? [...new Set(comparison.map((day) => relativeDay(day, date)))]
      : [relativeDay(message, date) ?? defaultDay];
  const closingOnly = closingQuestion.test(message);
  const names =
    language === "ar"
      ? { center: "المركز", laboratory: "المختبر", audiometry: "فحوصات السمع" }
      : {
          center: "Center",
          laboratory: "Laboratory",
          audiometry: "Audiometry",
        };
  const labels = [
    question.center && "center",
    question.lab && "laboratory",
    question.audio && "audiometry",
  ].filter(Boolean);
  const result = await Promise.all(
    days.map(async (day) => {
      let schedule;
      try {
        schedule = await readHours?.(day, { deadline });
      } catch {
        /* unavailable */
      }
      if (schedule?.publicationStatus !== "published" || schedule.date !== day)
        return {
          text:
            language === "ar"
              ? `الساعات المنشورة غير متاحة ليوم ${day}.`
              : `Published hours could not be checked for ${day}.`,
          complete: false,
        };
      if (schedule.centerClosed)
        return {
          text:
            language === "ar"
              ? `المركز مغلق في ${day}.`
              : `The center is closed on ${day}.`,
          complete: true,
        };
      const parts = labels.map((label) => {
        const row =
          label === "center"
            ? schedule.centerHours
            : schedule.otherServices?.find(({ id }) => id === label);
        return row &&
          timeRange.test(row.startTime) &&
          timeRange.test(row.endTime)
          ? {
              text: closingOnly
                ? language === "ar"
                  ? `يغلق ${names[label]} في ${day} عند ${row.endTime} بتوقيت بيروت`
                  : `The ${names[label]} closes at ${row.endTime} Beirut time on ${day}`
                : `${names[label]} ${day}: ${row.startTime}–${row.endTime}`,
              complete: true,
            }
          : {
              text:
                language === "ar"
                  ? `ساعات ${names[label]} غير منشورة في ${day}.`
                  : `${names[label]} hours are not published for ${day}.`,
              complete: false,
            };
      });
      return {
        text: parts.map(({ text }) => text).join(". "),
        complete: parts.every(({ complete }) => complete),
      };
    }),
  );
  const complete = result.every((entry) => entry.complete);
  const note =
    language === "ar"
      ? (closingOnly ? "" : "الأوقات بتوقيت بيروت. ") +
        "تواصل مع الاستقبال لتأكيد توفر الخدمة وتعليمات الزيارة."
      : (closingOnly ? "" : "Times are in Beirut. ") +
        "Published hours are not an appointment or a guarantee of individual availability. Contact Reception to confirm visit requirements.";
  return {
    text:
      result
        .map(({ text }) => text)
        .join(". ")
        .replace(/\.$/, "") +
      ". " +
      note,
    complete,
  };
}
