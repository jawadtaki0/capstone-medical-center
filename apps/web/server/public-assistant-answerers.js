import { laboratoryTests } from "../src/data/labAudioContent.js";
import { arabicLabContent } from "../src/data/publicLabArabic.js";
import { nameScore } from "./public-assistant-language.js";
import { scheduleSpecialty } from "./public-assistant-routing.js";
import { timePattern } from "./public-assistant-dates.js";

const localLab = (test, language) =>
  language === "ar" ? { ...test, ...arabicLabContent[test.id] } : test;

export const norm = (text) => text.normalize("NFKC").trim().toLowerCase();
export const specialtyWords = (text) =>
  " " +
  norm(text)
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim() +
  " ";
export function catalogueFacts(intent, lang) {
  const ids = Array.isArray(intent.tests) ? intent.tests.slice(0, 3) : [];
  const tests = laboratoryTests
    .filter((test) => ids.includes(test.id))
    .map((test) => localLab(test, lang));
  if (
    !tests.length ||
    tests.length !== new Set(ids).size ||
    (intent.compare === true && tests.length < 2)
  )
    return null;
  return tests;
}

export async function clinicWindowFacts({
  days,
  readSessions,
  deadline,
  professional,
  specialty,
  after,
  before,
  requiresAppointment,
  afternoonOnly,
  startsAtOrAfter,
  nextSession,
}) {
  const records = (
    await Promise.all(
      days.map(async (day) => {
        const rows = await readSessions(day, { deadline });
        if (!Array.isArray(rows))
          throw Error("Published schedule response is unavailable");
        return rows.filter((row) => row?.date === day);
      }),
    )
  ).flat();
  const published = records.filter(
    (row) =>
      typeof row.professionalName === "string" &&
      typeof row.specialty === "string" &&
      typeof row.professionalId === "string" &&
      typeof row.sourceSessionId === "string" &&
      row.published !== false,
  );
  const eligible = published.filter(
    (row) =>
      row.available !== false &&
      (!requiresAppointment ||
        (row.appointmentRequired === true && row.kind === "doctor")) &&
      timePattern.test(row.startTime) &&
      timePattern.test(row.endTime) &&
      (!specialty ||
        (scheduleSpecialty(row.specialty) || specialtyWords(row.specialty)) ===
          (scheduleSpecialty(specialty) || specialtyWords(specialty))) &&
      row.startTime < row.endTime,
  );
  let matchingProfessionals = eligible;
  if (professional) {
    const scored = published.map((row) => ({
      row,
      score: nameScore(professional, row.professionalName),
    }));
    const bestScore = scored.reduce(
      (best, { score }) => Math.max(best, score),
      0,
    );
    const identified = new Set(
      scored
        .filter(({ score }) => score > 0 && score === bestScore)
        .map(({ row }) => row.professionalId),
    );
    if (identified.size !== 1)
      return { matchCount: identified.size, matches: [] };
    matchingProfessionals = eligible.filter((row) =>
      identified.has(row.professionalId),
    );
  }
  const matches = matchingProfessionals
    .filter(
      (row) =>
        (!after ||
          (afternoonOnly || startsAtOrAfter
            ? row.startTime >= after
            : row.endTime > after)) &&
        (!before || row.startTime < before),
    )
    .sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime))
    .slice(0, nextSession ? 1 : 6);
  return { matchCount: null, matches };
}

export async function publishedHourFacts(question, days, readHours, deadline) {
  const labels = [
    question.center && "center",
    question.lab && "laboratory",
    question.audio && "audiometry",
  ].filter(Boolean);
  return Promise.all(
    days.map(async (day) => {
      let schedule;
      try {
        schedule = await readHours?.(day, { deadline });
      } catch {
        return { day, state: "unavailable" };
      }
      if (schedule?.publicationStatus !== "published" || schedule.date !== day)
        return { day, state: "unavailable" };
      if (schedule.centerClosed) return { day, state: "closed" };
      const services = labels.map((label) => {
        const row =
          label === "center"
            ? schedule.centerHours
            : schedule.otherServices?.find(({ id }) => id === label);
        const hours =
          row &&
          timePattern.test(row.startTime) &&
          timePattern.test(row.endTime)
            ? { startTime: row.startTime, endTime: row.endTime }
            : null;
        return { label, hours };
      });
      return { day, state: "open", services };
    }),
  );
}
