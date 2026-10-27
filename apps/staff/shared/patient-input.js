import { canonicalPhone } from "./contact-input.js";

export const PATIENT_FIELDS = Object.freeze([
  "firstName",
  "fatherName",
  "lastName",
  "motherFirstName",
  "dateOfBirth",
  "phone",
  "gender",
]);
export const PATIENT_LABELS = Object.freeze({
  firstName: "First name",
  fatherName: "Father’s name",
  lastName: "Last name",
  motherFirstName: "Mother’s maiden name",
  dateOfBirth: "Date of birth",
  phone: "Phone number",
  gender: "Gender",
});
export const PATIENT_ROLES = Object.freeze([
  "Admin",
  "Clinic Admin",
  "Lab Admin",
  "Receptionist",
]);
export const nameKey = (value) =>
  value.normalize("NFC").trim().replace(/\s+/gu, " ").toLowerCase();
export function patientToday(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Beirut",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}
export function realPatientDate(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    value.startsWith("0000")
  )
    return false;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(+date) && date.toISOString().slice(0, 10) === value;
}
export function patientInput(input, today) {
  const record = {},
    errors = {};
  for (const field of PATIENT_FIELDS.slice(0, 4)) {
    const value = input?.[field];
    if (
      typeof value !== "string" ||
      Array.from(value.trim()).length > 80 ||
      !/^\p{L}[\p{L}\p{M} .’'\-]*$/u.test(value.trim())
    )
      errors[field] =
        `Enter ${PATIENT_LABELS[field].toLowerCase()} (up to 80 letters and ordinary name punctuation).`;
    else record[field] = value.trim();
  }
  if (!realPatientDate(input?.dateOfBirth) || input.dateOfBirth > today)
    errors.dateOfBirth =
      "Enter a real date of birth that is not in the future.";
  else record.dateOfBirth = input.dateOfBirth;
  const phone = canonicalPhone(input?.phone, "LB");
  if (!phone)
    errors.phone = "Enter a valid phone number, such as +961 71 123 456.";
  else record.phone = phone;
  if (!["male", "female"].includes(input?.gender))
    errors.gender = "Choose the patient’s gender.";
  else record.gender = input.gender;
  return { record, errors };
}
// A one-character edit is allowed only when BOTH names have at least five
// Unicode characters. No phonetic/transliteration/Arabic-letter substitutions.
export function similarPatientName(left, right) {
  const a = Array.from(nameKey(left)),
    b = Array.from(nameKey(right));
  if (a.join("") === b.join("")) return true;
  if (Math.min(a.length, b.length) < 5 || Math.abs(a.length - b.length) > 1)
    return false;
  let i = 0,
    j = 0,
    edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length >= b.length) i++;
    if (b.length >= a.length) j++;
  }
  return edits + (i < a.length || j < b.length ? 1 : 0) <= 1;
}
export function patientNameSignatures(value) {
  const key = nameKey(value),
    letters = Array.from(key),
    values = new Set([key]);
  if (letters.length >= 5)
    for (let i = 0; i < letters.length; i++)
      values.add([...letters.slice(0, i), ...letters.slice(i + 1)].join(""));
  return [...values];
}
export function shiftPatientYear(date, years) {
  const [year, month, day] = date.split("-").map(Number),
    target = year + years;
  const end = new Date(0);
  end.setUTCFullYear(target, month, 0);
  const last = end.getUTCDate();
  return `${String(target).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(Math.min(day, last)).padStart(2, "0")}`;
}
export function classifyPatientDuplicate(record, other) {
  if (
    !similarPatientName(record.firstName, other.firstName) ||
    !similarPatientName(record.lastName, other.lastName)
  )
    return null;
  const sameDate = record.dateOfBirth === other.dateOfBirth;
  if (sameDate && similarPatientName(record.fatherName, other.fatherName))
    return "strong";
  const [earlier, later] = [record.dateOfBirth, other.dateOfBirth].sort();
  const withinYear = later <= shiftPatientYear(earlier, 1);
  return nameKey(record.motherFirstName) === nameKey(other.motherFirstName) ||
    withinYear
    ? "possible"
    : null;
}
