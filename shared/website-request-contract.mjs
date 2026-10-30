import { patientInput } from "../apps/staff/shared/patient-input.js";
export const REQUEST_SCHEMA = 1;
export const REQUEST_REASONS = Object.freeze({
  session_unavailable: { en: "Session unavailable", ar: "الجلسة غير متاحة" },
  details_check: {
    en: "Details need checking — please call the center",
    ar: "يرجى التحقق من التفاصيل — اتصل بالمركز",
  },
  already_received: {
    en: "Request already received — please contact the center",
    ar: "تم استلام الطلب مسبقًا — يرجى الاتصال بالمركز",
  },
  other: {
    en: "Other — please call the center",
    ar: "سبب آخر — يرجى الاتصال بالمركز",
  },
});
export class RequestError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
export const requestFail = (code, message, status) =>
  new RequestError(code, message, status);
export function exact(value, keys, required = keys) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !keys.includes(k)) ||
    required.some((k) => !Object.hasOwn(value, k))
  )
    throw requestFail("request_input", "Check the request fields.", 400);
}
export function secret(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value))
    throw requestFail(
      "request_unavailable",
      "This request link is unavailable.",
      404,
    );
  return value;
}
export function text(value, max = 240) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    /[\u0000-\u001f]/.test(value)
  )
    throw requestFail("request_input", "Check the request fields.", 400);
  return value.trim();
}
export function calendarDate(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(`${value}T12:00:00Z`)) ||
    new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) !== value
  )
    throw requestFail("request_input", "Choose a valid date.", 400);
  return value;
}
export function beirutEnd(date, time) {
  calendarDate(date);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time))
    throw requestFail("request_input", "Choose a valid window.", 400);
  const target = `${date} ${time}`;
  const format = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Beirut",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const wall = (at) => {
    const p = Object.fromEntries(
      format.formatToParts(at).map((x) => [x.type, x.value]),
    );
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
  };
  const base = Date.parse(`${date}T${time}:00Z`);
  const candidates = [];
  for (let offset = -180; offset <= 180; offset += 30) {
    const at = new Date(base + offset * 60000);
    if (wall(at) === target) candidates.push(at);
  }
  if (!candidates.length)
    throw requestFail(
      "request_input",
      "This local window does not exist.",
      400,
    );
  return candidates.at(-1);
}
export function intakeInput(value, today) {
  exact(value, ["submissionKey", "selection", "patient", "honeypot"]);
  secret(value.submissionKey);
  if (typeof value.honeypot !== "string" || value.honeypot.length)
    throw requestFail(
      "request_input",
      "The request could not be submitted.",
      400,
    );
  exact(
    value.selection,
    ["date", "professionalId", "sourceSessionId", "startTime", "endTime"],
    ["date", "professionalId", "sourceSessionId"],
  );
  calendarDate(value.selection.date);
  text(value.selection.professionalId, 120);
  text(value.selection.sourceSessionId, 120);
  if (
    value.selection.startTime !== undefined ||
    value.selection.endTime !== undefined
  ) {
    for (const field of ["startTime", "endTime"])
      if (
        typeof value.selection[field] !== "string" ||
        !/^([01]\d|2[0-3]):[0-5]\d$/.test(value.selection[field])
      )
        throw requestFail(
          "request_input",
          "Choose one valid attendance window.",
          400,
        );
    if (value.selection.startTime >= value.selection.endTime)
      throw requestFail(
        "request_input",
        "Choose one valid attendance window.",
        400,
      );
  }
  exact(value.patient, [
    "firstName",
    "fatherName",
    "lastName",
    "motherFirstName",
    "dateOfBirth",
    "phone",
    "gender",
    "preferredLanguage",
  ]);
  const { preferredLanguage, ...record } = value.patient;
  const checked = patientInput(record, today);
  if (
    Object.keys(checked.errors).length ||
    !["en", "ar"].includes(preferredLanguage)
  )
    throw requestFail(
      "request_input",
      "Check the required patient details.",
      400,
    );
  return { ...value, patient: { ...checked.record, preferredLanguage } };
}
export function publicRequest(r, now, { localReviewOnly = true } = {}) {
  if (typeof localReviewOnly !== "boolean")
    throw new Error("An explicit review-location flag is required.");
  return {
    schemaVersion: 1,
    reference: r.reference,
    status: r.status,
    professional: r.selection.professionalName,
    kind: r.selection.kind,
    date: r.selection.date,
    startTime: r.selection.startTime,
    endTime: r.selection.endTime,
    bookingReference: r.bookingReference ?? null,
    reason: r.reason ?? null,
    language: r.language,
    windowEnded: new Date(r.endsAt) <= now,
    localReviewOnly,
    events: r.events.map((e) => ({
      status: e.status,
      at: e.at,
      ...(e.reason ? { reason: e.reason } : {}),
    })),
  };
}
