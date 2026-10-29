import { REQUEST_REASONS } from "./website-request-contract.mjs";
export function websiteNoticeText(
  {
    name,
    reference,
    bookingReference,
    status,
    professional,
    kind,
    date,
    startTime,
    endTime,
    reason,
    trackingLink,
    contact,
  },
  language,
) {
  const ar = language === "ar",
    ltr = (v) => (ar ? `\u2066${v}\u2069` : v);
  const statuses = {
    confirmed: ar ? "مؤكد" : "CONFIRMED",
    rejected: ar ? "مرفوض" : "Rejected",
    cancelled: ar ? "ملغى" : "Cancelled",
    link_replaced: ar ? "تم استبدال رابط المتابعة" : "Tracking link replaced",
  };
  const title =
    kind === "doctor" ? (ar ? "د." : "Dr") : ar ? "الأخصائي" : "Specialist";
  return [
    `${ar ? "الاسم" : "Name"}: ${name}`,
    `${title}: ${professional.replace(/^Dr\.\s*/, "")}`,
    `${ar ? "التاريخ والوقت" : "Date and time"}: ${ltr(date)} · ${ltr(`${startTime}–${endTime}`)}`,
    `${ar ? "المرجع" : "Reference"}: ${reference}${bookingReference && bookingReference !== reference ? ` · ${bookingReference}` : ""}`,
    `*${statuses[status]}*`,
    status === "confirmed"
      ? ar
        ? "هذه فترة الحضور. ترتيب الاستشارات حسب تسجيل الحضور. يرجى مراجعة الاستقبال عند الوصول."
        : "This is your attendance window. Consultation order follows check-in. Please report to reception on arrival."
      : reason
        ? REQUEST_REASONS[reason]?.[language]
        : "",
    `${ar ? "للتواصل مع المركز" : "Center contact"}: ${ltr(contact)}`,
    trackingLink ?? "",
    ar ? "مركز سيدر للخدمات الطبية CMC" : "Cedar Medical Center CMC",
  ]
    .filter(Boolean)
    .join("\n");
}
