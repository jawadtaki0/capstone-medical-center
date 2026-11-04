import { useEffect, useRef, useState } from "react";
import { REQUEST_REASONS as REASONS } from "../../../../shared/website-request-contract.mjs";
const STATUSES = {
  awaiting: { en: "Awaiting confirmation", ar: "بانتظار التأكيد" },
  confirmed: { en: "Confirmed", ar: "مؤكد" },
  rejected: { en: "Rejected", ar: "مرفوض" },
  cancelled: { en: "Cancelled", ar: "ملغى" },
};

export const STATUS_EXPLANATIONS = {
  awaiting: {
    en: "Reception is reviewing your request. No appointment is reserved until it is confirmed.",
    ar: "يراجع موظفو الاستقبال طلبك. لا يُحجز موعد حتى يتم تأكيد الطلب.",
  },
  confirmed: {
    en: "Reception has confirmed your request. Your attendance window and details are below.",
    ar: "أكد موظفو الاستقبال طلبك. تظهر فترة الحضور والتفاصيل أدناه.",
  },
  rejected: {
    en: "Reception could not confirm this request. Any supplied reason appears below.",
    ar: "لم يتمكن موظفو الاستقبال من تأكيد هذا الطلب. يظهر السبب أدناه إذا كان متاحًا.",
  },
  cancelled: {
    en: "This request has been cancelled. It does not reserve an appointment.",
    ar: "أُلغي هذا الطلب. لا يحجز الطلب الملغى موعدًا.",
  },
};

export default function TrackingView({
  request,
  data: projection,
  onLanguage,
  requestHref = "#request",
}) {
  const [language, setLanguage] = useState(
      projection?.language ?? request?.patient.preferredLanguage ?? "en",
    ),
    title = useRef(null);
  const ar = language === "ar",
    data = projection ?? request;
  useEffect(() => {
    title.current?.focus({ preventScroll: true });
    onLanguage(language);
  }, [language]);
  useEffect(() => {
    if (projection) setLanguage(projection.language);
    else if (request) setLanguage(request.language);
  }, [request?.reference, projection?.reference]);
  if (!data)
    return (
      <section className="request-card request-receipt">
        <h1 ref={title} tabIndex={-1}>
          {ar ? "رابط المتابعة غير متاح" : "Tracking link unavailable"}
        </h1>
        <p>
          {ar
            ? "استخدم الرابط الخاص الكامل الذي حفظته. رقم المرجع وحده لا يتيح الوصول."
            : "Use your saved complete private link. A request reference alone does not provide access."}
        </p>
        <p>
          {ar
            ? "تواصل مع موظفي المركز لطلب استبدال الرابط. لا يُرسل البديل إلا إلى رقم الهاتف المُقدَّم أصلًا مع هذا الطلب. معرفة الاسم أو رقم المرجع لا تتيح الوصول ولا تثبت الهوية."
            : "Contact the center's staff about a replacement. It can be delivered only to the phone originally submitted with this request. Knowing a name or reference does not provide access or establish identity."}
        </p>
        <a href={requestHref} className="button button-secondary">
          {ar ? "طلب جديد" : "New request"}
        </a>
      </section>
    );
  return (
    <section
      className="request-tracking"
      dir={ar ? "rtl" : "ltr"}
      lang={language}
    >
      <div className="request-intro tracking-status-intro">
        <p className="tracking-context">
          {ar ? "متابعة طلبك" : "Track your request"}
        </p>
        <h1
          ref={title}
          tabIndex={-1}
          className={`tracking-status-heading status-heading-${data.status}`}
        >
          {STATUSES[data.status][language]}
        </h1>
        <p>{STATUS_EXPLANATIONS[data.status][language]}</p>
        <p className="tracking-sync-note">
          {ar
            ? "المعروض أدناه هو آخر تحديث تمت مزامنته لهذه الصفحة."
            : "This page shows the last successfully synchronized update for this request."}
        </p>
      </div>
      <div className="request-card">
        <div className="request-tracking-top">
          <h2>{ar ? "تفاصيل الطلب" : "Request details"}</h2>
          <label className="request-language">
            {ar ? "اللغة" : "Language"}
            <select
              aria-label="Tracking language"
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
            >
              <option value="en">English</option>
              <option value="ar">العربية</option>
            </select>
          </label>
        </div>
        <dl className="request-review-grid">
          <div>
            <dt>{ar ? "مرجع الطلب" : "Request reference"}</dt>
            <dd dir="ltr">{data.reference}</dd>
          </div>
          {data.bookingReference && (
            <div>
              <dt>{ar ? "مرجع الحجز" : "Booking reference"}</dt>
              <dd dir="ltr">{data.bookingReference}</dd>
            </div>
          )}
          <div>
            <dt>{ar ? "الطبيب أو الأخصائي" : "Professional"}</dt>
            <dd>
              <bdi>{data.professional}</bdi>
            </dd>
          </div>
          <div>
            <dt>{ar ? "التاريخ" : "Date"}</dt>
            <dd dir="ltr">{data.date}</dd>
          </div>
          <div>
            <dt>{ar ? "فترة الحضور" : "Attendance window"}</dt>
            <dd dir="ltr">
              {data.startTime}–{data.endTime} · Asia/Beirut
            </dd>
          </div>
        </dl>
        {data.reason && (
          <div className="request-alert">
            <strong>{ar ? "سبب الحالة" : "Status reason"}</strong>
            <p>{REASONS[data.reason]?.[language]}</p>
          </div>
        )}
        <div className="request-alert">
          <strong>
            {data.status === "confirmed"
              ? ar
                ? "معلومات الحضور"
                : "Before you arrive"
              : ar
                ? "يرجى حفظ هذا الرابط"
                : "Keep your private link"}
          </strong>
          <p>
            {data.status === "confirmed"
              ? ar
                ? "هذه فترة الحضور وليست موعدًا دقيقًا للاستشارة. ترتيب الاستشارات حسب تسجيل الحضور."
                : "This is your attendance window, not an exact consultation time. Consultation order follows check-in."
              : data.status === "awaiting"
                ? ar
                  ? "يراجع الموظف طلبك. إرسال الطلب لا يحجز مكانًا، ورسائل واتساب تُرسل يدويًا. تابع هذه الصفحة لمعرفة المستجدات."
                  : "Staff reviews your request. Submission reserves no place, and WhatsApp messages are sent manually. Check this page for updates."
                : ar
                  ? "احتفظ بهذا الرابط الخاص لعرض التحديثات التي تمت مزامنتها. تُرسل رسائل واتساب يدويًا."
                  : "Keep this private link to view synchronized updates. WhatsApp messages are sent manually."}
          </p>
        </div>
      </div>
      <div className="request-card">
        <h2>{ar ? "تحديثات الطلب" : "Request updates"}</h2>
        <ol className="request-timeline">
          {data.events.map((event, i) => (
            <li key={`${event.at}:${i}`}>
              <span className="request-timeline-dot" aria-hidden="true" />
              <div>
                <strong>{STATUSES[event.status][language]}</strong>
                <time dateTime={event.at} dir="ltr">
                  {new Intl.DateTimeFormat(ar ? "ar-LB" : "en-GB", {
                    dateStyle: "medium",
                    timeStyle: "short",
                    timeZone: "Asia/Beirut",
                  }).format(new Date(event.at))}
                </time>
                {event.reason && <p>{REASONS[event.reason]?.[language]}</p>}
              </div>
            </li>
          ))}
        </ol>
        <p className="request-muted">
          {ar
            ? "تظهر فقط التحديثات التي تمت مزامنتها. هذا الرابط لا يتيح الوصول إلى الملف الصحي أو النتائج."
            : "Only synchronized updates appear. This link does not grant access to patient history or results."}
        </p>
      </div>
    </section>
  );
}
