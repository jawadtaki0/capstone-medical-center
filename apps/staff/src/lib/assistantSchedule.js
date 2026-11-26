import { cleanOperationalRecord, oneDateReplacement } from "./operations.js";

// What was typed only pre-selects; the person checks every field.
const words = (text) =>
  (text.toLowerCase().match(/\p{L}{3,}/gu) ?? []).filter(
    (word) => !["the", "دكتور", "الدكتور"].includes(word),
  );
const digits = (text) => text.replace(/[٠-٩]/g, (d) => "٠١٢٣٤٥٦٧٨٩".indexOf(d));

export function matchProfessionals(text, professionals) {
  const typed = new Set(words(text));
  return professionals.filter((p) =>
    words(p.name).some((word) => typed.has(word)),
  );
}

export function readLimit(message) {
  const text = digits(message).replace(/\d{4}-\d{1,2}-\d{1,2}/g, " ");
  const range =
    /(?:from|من)\s*(\d{1,3})\s*(?:to|الى|إلى|لـ|ل)\s*(\d{1,3})/i.exec(text);
  if (range) return { from: Number(range[1]), to: Number(range[2]) };
  const target = /(?:to|الى|إلى)\s*(\d{1,3})(?![\d/.-])/i.exec(text);
  return target ? { to: Number(target[1]) } : {};
}

// The same requests the Schedules screen sends.
export function limitChange(session, capacity) {
  return {
    type: "sessions",
    record: cleanOperationalRecord("sessions", { ...session, capacity }),
    expectedRevision: session.revision,
  };
}

export function absenceChange(state, date, professionalId) {
  const model = oneDateReplacement(
    state,
    date,
    `professional|${professionalId}`,
    true,
    [],
  );
  return {
    affected: model.affected,
    request: {
      type: "exceptions",
      record: model.record,
      expectedRevision: model.prior?.revision ?? 0,
    },
  };
}
