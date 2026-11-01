// Synthetic presentation fixtures, not real schedules, issued numbers or tokens.
// This module imports ONLY pure validation helpers, never the staff application,
// authority, credentials, Electron bridge, API service or private records.
import {
  patientInput,
  classifyPatientDuplicate,
} from "../../../staff/shared/patient-input.js";

export const PROFESSIONALS = [
  {
    id: "demo:doctor:sami",
    name: "Dr. Sami Demo",
    specialty: "Cardiology",
    gender: "male",
    kind: "doctor",
  },
  {
    id: "demo:doctor:lina",
    name: "Dr. Lina Demo",
    specialty: "Pediatrics, Neonatology, and General Health",
    gender: "female",
    kind: "doctor",
  },
  {
    id: "demo:specialist:nour",
    name: "Nour Demo",
    specialty: "Therapist",
    gender: "female",
    kind: "specialist",
  },
];
export const PREVIEW_DATES = ["2026-11-02", "2026-11-03", "2026-11-04"];
export const SESSIONS = PREVIEW_DATES.flatMap((date) =>
  PROFESSIONALS.map((p, i) => ({
    id: `demo:${date}:${p.id}`,
    professionalId: p.id,
    date,
    startTime: ["09:00", "10:30", "13:00"][i],
    endTime: ["11:00", "12:00", "14:30"][i],
    appointmentRequired: i !== 0,
  })),
);
export const STATUSES = {
  awaiting: { en: "Awaiting confirmation", ar: "بانتظار التأكيد" },
  confirmed: { en: "Confirmed", ar: "مؤكد" },
  rejected: { en: "Rejected", ar: "مرفوض" },
  cancelled: { en: "Cancelled", ar: "ملغى" },
};
export const REASONS = {
  session_unavailable: { en: "Session unavailable", ar: "الجلسة غير متاحة" },
  details_check: {
    en: "Details need checking — please call the center",
    ar: "يجب التحقق من التفاصيل — يرجى الاتصال بالمركز",
  },
  already_received: {
    en: "Request already received — please contact the center",
    ar: "تم استلام الطلب سابقًا — يرجى التواصل مع المركز",
  },
  other: {
    en: "Other — please call the center",
    ar: "سبب آخر — يرجى الاتصال بالمركز",
  },
};
export const SAMPLE_PATIENT = {
  firstName: "Synthetic",
  fatherName: "Patientfather",
  lastName: "Requestdemo",
  motherFirstName: "Patientmother",
  dateOfBirth: "2000-02-29",
  phone: "+96171123456",
  gender: "female",
  preferredLanguage: "en",
};
export const MATCHES = [
  {
    id: "demo:patient:one",
    patientNumber: "P-DEMO-001",
    ...SAMPLE_PATIENT,
    classification: "Strong candidate",
    discrepancy: "Date of birth matches.",
  },
  {
    id: "demo:patient:two",
    patientNumber: "P-DEMO-002",
    ...SAMPLE_PATIENT,
    dateOfBirth: "2001-02-28",
    classification: "Possible candidate",
    discrepancy: "Submitted: 2000-02-29 · existing: 2001-02-28. Dates differ.",
  },
];
export const fullName = (p) =>
  [p.firstName, p.fatherName, p.lastName].join(" ");
export const matchCandidates = (patient) =>
  MATCHES.flatMap((p) => {
    const match = classifyPatientDuplicate(patient, p);
    return match
      ? [
          {
            ...p,
            classification:
              match === "strong" ? "Strong candidate" : "Possible candidate",
            discrepancy:
              patient.dateOfBirth === p.dateOfBirth
                ? "Date of birth matches."
                : `Submitted: ${patient.dateOfBirth} · existing: ${p.dateOfBirth}. Dates differ.`,
          },
        ]
      : [];
  });
export const professionalFor = (s) =>
  PROFESSIONALS.find((p) => p.id === s.professionalId);
export function validateDetails(value) {
  const { preferredLanguage, ...patient } = value;
  const result = patientInput(patient, "2026-10-28");
  if (!["en", "ar"].includes(preferredLanguage))
    result.errors.preferredLanguage = "Choose Arabic or English.";
  return result.errors;
}
export function publicTracking(request) {
  // Explicit public projection: never spread a request/patient/note into this.
  return {
    reference: request.reference,
    status: request.publicStatus,
    professional: professionalFor(request.session).name,
    date: request.session.date,
    startTime: request.session.startTime,
    endTime: request.session.endTime,
    bookingReference: request.publicBookingReference ?? null,
    reason: request.publicReason ?? null,
    language: request.patient.preferredLanguage,
    events: request.publicEvents.map(({ status, at, reason }) => ({
      status,
      at,
      ...(reason ? { reason } : {}),
    })),
  };
}
export function notificationText(
  request,
  language = request.patient.preferredLanguage,
) {
  const p = professionalFor(request.session),
    s = request.session;
  const ar = language === "ar";
  const contact = ar
    ? "[رقم المركز — بانتظار الاعتماد]"
    : "[Center contact — pending approval]";
  const reason = request.reason ? REASONS[request.reason]?.[language] : "";
  // WhatsApp uses single asterisks for bold; the visual preview renders only
  // that fixed status markup, never arbitrary HTML from patient input.
  const name = fullName(request.patient);
  const readable = (value) => (ar ? `\u2066${value}\u2069` : value);
  const professional =
    p.kind === "doctor"
      ? `${ar ? "د." : "Dr"}: ${p.name.replace(/^Dr\.\s*/, "")}`
      : `${ar ? "الأخصائي" : "Specialist"}: ${p.name}`;
  const reference =
    request.bookingReference && request.bookingReference !== request.reference
      ? `${request.reference} · ${request.bookingReference}`
      : request.reference;
  return [
    `${ar ? "الاسم" : "Name"}: ${name}`,
    professional,
    `${ar ? "التاريخ والوقت" : "Date and time"}: ${readable(s.date)} · ${readable(`${s.startTime}–${s.endTime}`)}`,
    `${ar ? "المرجع" : "Reference"}: ${reference}`,
    `*${request.status === "confirmed" ? (ar ? "مؤكد" : "CONFIRMED") : STATUSES[request.status][language]}*`,
    request.status === "confirmed"
      ? ar
        ? "هذه فترة الحضور. ترتيب الاستشارات حسب تسجيل الحضور. يرجى مراجعة الاستقبال عند الوصول."
        : "This is your attendance window. Consultation order follows check-in. Please report to reception on arrival."
      : reason,
    `${ar ? "للتواصل مع المركز" : "Center contact"}: ${contact}`,
    request.source === "phone"
      ? ""
      : ar
        ? "[رابط المتابعة الخاص — نموذج فقط]"
        : "[Private tracking link — preview only]",
    ar ? "مركز سيدر للخدمات الطبية CMC" : "Cedar Medical Center CMC",
  ]
    .filter(Boolean)
    .join("\n");
}
