import { plain } from "./text.js";

const WEEKDAYS = [
  ["sunday", "الاحد"],
  ["monday", "الاثنين", "التنين"],
  ["tuesday", "الثلاثاء", "التلاتا"],
  ["wednesday", "الاربعاء", "الاربعا"],
  ["thursday", "الخميس"],
  ["friday", "الجمعة", "الجمعه"],
  ["saturday", "السبت"],
];

const add = (day, count) => {
  const value = new Date(`${day}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + count);
  return value.toISOString().slice(0, 10);
};
const real = (day) => {
  const value = new Date(`${day}T12:00:00Z`);
  return Number.isFinite(+value) && value.toISOString().slice(0, 10) === day;
};
export const westernDigits = (text) =>
  text.replace(/[٠-٩]/g, (d) => "٠١٢٣٤٥٦٧٨٩".indexOf(d));

// Reads a date from typed text with plain rules, never from the model.
// `today` is the Asia/Beirut date. Returns null when the text names none.
export function readDate(message, today) {
  const text = westernDigits(plain(message));
  const iso = /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/.exec(text);
  const local = /\b(\d{1,2})[/.](\d{1,2})[/.](\d{4})\b/.exec(text);
  const match = iso
    ? [iso[1], iso[2], iso[3]]
    : local && [local[3], local[2], local[1]];
  if (match) {
    const day = `${match[0]}-${match[1].padStart(2, "0")}-${match[2].padStart(2, "0")}`;
    return real(day) ? day : null;
  }
  if (/day after tomorrow|بعد بكرا|بعد بكرة|بعد غد/.test(text))
    return add(today, 2);
  if (/tomorrow|بكرا|بكرة|(^|\s)غدا|الغد/.test(text)) return add(today, 1);
  if (/\btoday\b|اليوم|هلق/.test(text)) return today;
  const weekday = WEEKDAYS.findIndex((names) =>
    names.some((name) => text.includes(name)),
  );
  if (weekday < 0) return null;
  const current = new Date(`${today}T12:00:00Z`).getUTCDay();
  return add(today, (weekday - current + 7) % 7);
}

// Every date named: all explicit ones, otherwise the single relative one.
export function readDates(message, today) {
  const explicit = westernDigits(message).match(
    /\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[/.]\d{1,2}[/.]\d{4}/g,
  );
  const found = (explicit ?? [message]).map((part) => readDate(part, today));
  return [...new Set(found.filter((day) => day && day >= today))];
}
