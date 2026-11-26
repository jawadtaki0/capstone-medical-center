import { publishedAnswer, reviewedMatch } from "./public-assistant-content.js";
import {
  catalogueIntent,
  combinedRequestParts,
  hoursQuestion,
  publicServiceAnswer,
} from "./public-assistant-facts.js";
import {
  isCurrentWeek,
  resolveTurnDates,
  sameDayReference,
} from "./public-assistant-dates.js";
import {
  genericArabiziAvailability,
  identityQuestion,
  refinementQuestion,
  scheduleRequest,
  specialtyCorrection,
} from "./public-assistant-routing.js";

export function classifyPublicTurn(
  latest,
  { date, lang, context, activeSearch },
) {
  const catalogue = catalogueIntent(latest);
  const service = publicServiceAnswer(latest, lang, catalogue);
  if (service)
    return {
      kind: "reference",
      fields: service,
      route: service.kind ?? "library",
    };
  const publicInfo = publishedAnswer(latest, lang);
  if (publicInfo) {
    const { topic, text, reception } = publicInfo;
    return {
      kind: "reference",
      route: topic ? "library" : "reception",
      fields: {
        text,
        ...(topic ? { page: "/services/" + topic } : {}),
        reception,
      },
    };
  }
  if (/\bwhat time do you close\b/i.test(latest))
    return { kind: "ambiguousService" };
  const parts = combinedRequestParts(latest);
  const sessionMessage = parts?.session ?? latest;
  const hoursMessage = parts?.hours ?? latest;
  const hours = hoursQuestion(hoursMessage);
  const { clinic, hourDays, conflict } = resolveTurnDates(
    sessionMessage,
    hoursMessage,
    hours,
    Boolean(parts),
    date,
    context,
  );
  const request = scheduleRequest(sessionMessage, date, clinic);
  const {
    day,
    specialty: specialtyHint,
    clinician: namedProfessional,
  } = request;
  if (
    conflict ||
    (!hours &&
      request.specified &&
      !day &&
      (request.availability || activeSearch || sameDayReference(latest)))
  )
    return { kind: "ambiguousDate" };
  const combinedSchedule = Boolean(
    parts && hours && (specialtyHint || namedProfessional),
  );
  const time =
    combinedSchedule && /plan.*morning/i.test(latest) ? {} : request.time;
  const hasTime = Object.keys(time).length > 0;
  const nameClarification =
    activeSearch?.awaitingProfessional &&
    !hours &&
    !specialtyHint &&
    !day &&
    !hasTime &&
    /^(?:(?:dr\.?|doctor|دكتور|الدكتور)\s+)?[\p{L}][\p{L}'’-]+(?:\s+[\p{L}][\p{L}'’-]+){1,2}[.?!؟]?$/iu.test(
      latest.trim(),
    )
      ? latest.trim()
      : "";
  const booking =
    /\b(?:book|reserve|schedule) (?:me|that|the|it)\b|احجز لي|احجزلي/iu.test(
      latest,
    );
  const onScreenChoice =
    activeSearch &&
    /\b(?:one|session|slot|appointment)\b|الجلسة|الموعد/iu.test(latest);
  const referencedRefinement = Boolean(
    activeSearch &&
    hasTime &&
    !specialtyHint &&
    !namedProfessional &&
    sameDayReference(latest),
  );
  const directSearch =
    !referencedRefinement && (request.availability || combinedSchedule);
  const refinement =
    !directSearch &&
    (referencedRefinement ||
      nameClarification ||
      (refinementQuestion(latest) &&
        (!activeSearch || day || hasTime || specialtyHint)) ||
      (activeSearch &&
        (day || hasTime) &&
        /\b(?:actually|make that|switch|change|move|what about|how about)\b|طيب|والجمع[هة]/iu.test(
          latest,
        )) ||
      (activeSearch && specialtyHint && specialtyCorrection(latest)) ||
      (activeSearch &&
        (day || hasTime) &&
        !specialtyHint &&
        !namedProfessional &&
        !/\b(?:lab(?:oratory)?|audiometry|hearing|sama3|test|price)\b|مختبر|السمع|فحص|تحليل|سعر/iu.test(
          latest,
        )));
  const entry = reviewedMatch(latest, lang);
  const avoidClinicSearch =
    entry &&
    (entry.topic !== "clinic" || entry.id.startsWith("clinic-confirmation"));
  const maySearch =
    !avoidClinicSearch && (directSearch || (refinement && activeSearch));
  const comparison =
    /\b(?:fasting (?:blood )?(?:glucose|sugar)|fbg|fpg|fbs)\b/i.test(latest) &&
    /\b(?:hb\s*a1c|a1c|glycated hemoglobin)\b/i.test(latest);
  const preparation =
    context?.labPair && /fast(?:ing)?\b|صيام|صوم|siyam/i.test(latest);
  let lab = catalogue;
  if ((comparison || preparation) && !lab?.preparation)
    lab = {
      kind: "labs",
      tests: ["fasting-glucose", "hba1c"],
      compare: !preparation,
    };
  const knownSearch =
    maySearch &&
    (specialtyHint ||
      genericArabiziAvailability(latest) ||
      (refinement && (day || hasTime || nameClarification)));
  const requiresAppointment =
    /\brequire[s]? an? appointment\b/i.test(latest) ||
    Boolean(refinement && activeSearch?.filters?.requiresAppointment);
  if (
    day &&
    !specialtyHint &&
    !namedProfessional &&
    !refinement &&
    /\b(?:[a-z]{3,}(?:ologist|ology|iatrist)|[a-z]+ specialist)\b|(?:اختصاصي|اخصائي)\s+[\p{L}]+/iu.test(
      latest,
    )
  )
    return { kind: "ambiguousSpecialty" };
  const currentWeek = isCurrentWeek(latest);
  const nextSession = /\bnext\b/i.test(latest) && Boolean(specialtyHint);
  const fixedSearch =
    directSearch &&
    (combinedSchedule ||
      requiresAppointment ||
      namedProfessional ||
      currentWeek ||
      nextSession ||
      (specialtyHint && day) ||
      /^\s*(?:sessions?|clinic sessions?)\s+(?:today|tomorrow)\s*[?.!]*$/i.test(
        latest,
      ));
  return {
    kind:
      hours && !combinedSchedule
        ? "hours"
        : lab
          ? "labs"
          : entry
            ? "library"
            : maySearch
              ? "sessions"
              : "unknown",
    lab,
    entry,
    parts,
    hours,
    hoursMessage,
    hourDays,
    combinedSchedule,
    day,
    specialtyHint,
    namedProfessional,
    time,
    hasTime,
    nameClarification,
    booking,
    onScreenChoice,
    directSearch,
    refinement,
    identity: identityQuestion(latest),
    maySearch,
    comparison,
    preparation,
    knownSearch,
    requiresAppointment,
    currentWeek,
    nextSession,
    fixedSearch,
  };
}
