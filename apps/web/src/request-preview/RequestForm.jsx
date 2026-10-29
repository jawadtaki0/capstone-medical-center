import { useEffect, useId, useRef, useState } from "react";
import {
  DateField,
  ProfessionalCombobox,
  RequestPhone,
} from "./FormControls.jsx";
import { patientInput } from "../../../staff/shared/patient-input.js";
import { createSubmissionAttempt } from "../website-request-client.js";
function makeSubmissionKey() {
  return btoa(
    String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))),
  )
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
import SpecialtyIcon from "../components/SpecialtyIcon.jsx";
import ProfessionalAvatar from "../components/ProfessionalAvatar.jsx";

const copy = {
  en: {
    title: "Request a clinic session",
    intro:
      "Choose a full attendance window with a doctor or specialist. Our team reviews every request before confirming a place.",
    steps: ["Choose session", "Patient details", "Review"],
    pending: "A request is not a booking",
    warning:
      "Submitting reserves no place. Reception must confirm your request. Your attendance window is not an exact consultation time; consultation order follows check-in.",
    date: "Session date",
    choose: "Choose an available session window",
    noSessions: "No published sessions for this selection",
    next: "Continue",
    back: "Back",
    submit: "Submit request",
    details: "Patient details",
    review: "Review your request",
    mother: "Mother’s maiden name",
    first: "First name",
    father: "Father’s name",
    last: "Last name",
    dob: "Date of birth",
    gender: "Gender",
    language: "Preferred language",
    empty: "Choose",
    female: "Female",
    male: "Male",
    privacy:
      "These details are for reception to review this request. This does not create an account or grant access to patient history or results.",
    receipt: "Request received",
    save: "Save this private link",
    saveText:
      "Keep this link somewhere safe. It is how you check this request without an account. Do not share it publicly.",
    track: "View tracking",
    copy: "Copy tracking link",
    awaiting: "Awaiting confirmation",
    manual:
      "Reception reviews requests. WhatsApp messages are sent manually; please check tracking for updates.",
    formError: "Check the highlighted fields before continuing.",
    sample: "Fill synthetic example",
    change: "Edit",
    pick: "Choose a professional and session before continuing.",
    attendance: "Full attendance window",
    noCount:
      "Availability is checked by staff at confirmation. No place is reserved yet.",
  },
  ar: {
    title: "طلب جلسة في العيادة",
    intro:
      "اختر فترة حضور كاملة مع طبيب أو أخصائي. يراجع فريقنا كل طلب قبل تأكيد مكان.",
    steps: ["اختر الجلسة", "بيانات المريض", "المراجعة"],
    pending: "الطلب ليس حجزًا مؤكدًا",
    warning:
      "إرسال الطلب لا يحجز مكانًا. يجب أن يؤكد الاستقبال طلبك. فترة الحضور ليست موعدًا دقيقًا للاستشارة؛ ترتيب الاستشارات حسب تسجيل الحضور.",
    date: "تاريخ الجلسة",
    choose: "اختر فترة الجلسة",
    noSessions: "لا توجد جلسات منشورة لهذا الاختيار",
    next: "متابعة",
    back: "رجوع",
    submit: "إرسال الطلب",
    details: "بيانات المريض",
    review: "راجع طلبك",
    mother: "اسم الأم قبل الزواج",
    first: "الاسم الأول",
    father: "اسم الأب",
    last: "اسم العائلة",
    dob: "تاريخ الولادة",
    gender: "الجنس",
    language: "اللغة المفضلة",
    empty: "اختر",
    female: "أنثى",
    male: "ذكر",
    privacy:
      "هذه البيانات لمراجعة الاستقبال لهذا الطلب. لا تُنشئ حسابًا ولا تتيح الاطلاع على التاريخ الصحي أو النتائج.",
    receipt: "تم استلام الطلب",
    save: "احفظ هذا الرابط الخاص",
    saveText:
      "احتفظ بهذا الرابط في مكان آمن لمتابعة هذا الطلب دون حساب. لا تنشره للعامة.",
    track: "متابعة الطلب",
    copy: "نسخ رابط المتابعة",
    awaiting: "بانتظار التأكيد",
    manual:
      "يراجع الاستقبال الطلبات وتُرسل رسائل واتساب يدويًا. يرجى متابعة الرابط لمعرفة المستجدات.",
    formError: "راجع الحقول المحددة قبل المتابعة.",
    sample: "تعبئة مثال تجريبي",
    change: "تعديل",
    pick: "اختر الطبيب أو الأخصائي والجلسة قبل المتابعة.",
    attendance: "فترة الحضور الكاملة",
    noCount: "يتحقق الموظف من التوفر عند التأكيد. لم يُحجز مكان بعد.",
  },
};
export function SessionSummary({
  session,
  language = "en",
  professional = {
    name: session?.professionalName,
    specialty: session?.specialty,
    gender: session?.avatarVariant,
  },
}) {
  if (!session) return null;

  return (
    <div className="request-session-summary">
      <ProfessionalAvatar avatarVariant={professional.gender} />
      <div>
        <strong>{professional.name}</strong>
        <p>{professional.specialty}</p>
        <p>
          <bdi dir="ltr">
            {session.date} · {session.startTime}–{session.endTime}
          </bdi>{" "}
          · {language === "ar" ? "بتوقيت بيروت" : "Asia/Beirut"}
        </p>
      </div>
    </div>
  );
}
export default function RequestForm({
  language,
  onLanguage,
  scenario = "ready",
  onToast,
  professionals = [],
  sessions = [],
  sample = null,
  submitRequest,
  onDateChange,
  initialDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Beirut",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date()),
  trackingBase = "/track#",
  preview = false,
}) {
  const PROFESSIONALS = professionals,
    SESSIONS = sessions,
    professionalFor = (s) =>
      professionals.find((p) => p.id === s?.professionalId) ?? {
        name: s?.professionalName,
        specialty: s?.specialty,
        gender: s?.avatarVariant,
      };
  const t = copy[language],
    id = useId(),
    heading = useRef(null),
    submitting = useRef(false),
    alive = useRef(true);
  const [step, setStep] = useState(0),
    [professional, setProfessional] = useState(""),
    [date, setDate] = useState(initialDate),
    [selected, setSelected] = useState(""),
    [details, setDetails] = useState({
      firstName: "",
      fatherName: "",
      lastName: "",
      motherFirstName: "",
      dateOfBirth: "",
      phone: "",
      gender: "",
      preferredLanguage: language,
    }),
    [errors, setErrors] = useState({}),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [receipt, setReceipt] = useState(null),
    [phoneKey, setPhoneKey] = useState(0);
  const honeypot = useRef(null);
  const submissionAttempt = useRef(createSubmissionAttempt(makeSubmissionKey)),
    session = SESSIONS.find((s) => s.id === selected),
    matching =
      scenario === "empty"
        ? []
        : SESSIONS.filter(
            (s) => s.professionalId === professional && s.date === date,
          );
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, [step, receipt]);
  useEffect(() => {
    onDateChange?.(date);
  }, [date]);
  function edit(k, value) {
    setDetails((p) => ({ ...p, [k]: value }));
    setErrors((e) => ({ ...e, [k]: undefined }));
  }
  function advance(e) {
    e?.preventDefault();
    setMessage("");
    if (step === 0) {
      if (!session || !matching.some((s) => s.id === session.id)) {
        setMessage(t.pick);
        return;
      }
      setStep(1);
    } else if (step === 1) {
      const { preferredLanguage, ...record } = details;
      const problems = patientInput(
        record,
        preview
          ? "2026-10-28"
          : new Intl.DateTimeFormat("en-CA", {
              timeZone: "Asia/Beirut",
              year: "numeric",
              month: "2-digit",
              day: "2-digit",
            }).format(new Date()),
      ).errors;
      setErrors(problems);
      if (Object.keys(problems).length) {
        setMessage(t.formError);
        return;
      }
      submissionAttempt.current(
        details,
        session,
        honeypot.current?.value ?? "",
      );
      setStep(2);
    }
  }
  async function submit(e) {
    e.preventDefault();
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setMessage("");
    try {
      if (preview) await new Promise((r) => setTimeout(r, 550));
      if (!alive.current) return;
      if (preview && scenario === "unavailable")
        throw Error(
          language === "ar"
            ? "تعذر إرسال الطلب في هذا العرض. لم تُنشأ رسالة استلام. احتُفظ بالبيانات لإعادة المحاولة."
            : "The simulated request service is unavailable. No receipt was created. Your details are kept for retry.",
        );
      const saved = await submitRequest(
        details,
        session,
        submissionAttempt.current(
          details,
          session,
          honeypot.current?.value ?? "",
        ),
        honeypot.current?.value ?? "",
      );
      if (alive.current)
        setReceipt({
          ...saved,
          session: {
            ...session,
            professionalName: professionalFor(session).name,
            specialty: professionalFor(session).specialty,
            avatarVariant: professionalFor(session).gender,
          },
        });
    } catch (e) {
      if (alive.current) setMessage(e.forLanguage?.(language) ?? e.message);
    } finally {
      submitting.current = false;
      if (alive.current) setBusy(false);
    }
  }
  if (receipt) {
    const link = `${window.location.origin}${trackingBase}${receipt.trackingToken}`;
    return (
      <div className="request-receipt request-card">
        <span className="request-success-symbol" aria-hidden="true">
          ✓
        </span>
        <p className="eyebrow">{t.awaiting}</p>
        <h1 ref={heading} tabIndex={-1}>
          {t.receipt}
        </h1>
        <p>
          {language === "ar" ? "مرجع الطلب" : "Request reference"}:{" "}
          <strong dir="ltr">{receipt.reference}</strong>
        </p>
        <SessionSummary
          session={receipt.session}
          language={language}
          professional={professionalFor(receipt.session)}
        />
        <div className="request-alert">
          <h2>{t.save}</h2>
          <p>{t.saveText}</p>
        </div>
        <div className="request-link-box">
          <input
            aria-label={t.save}
            dir="ltr"
            readOnly
            value={link}
            onFocus={(e) => e.target.select()}
          />
          <button
            type="button"
            className="button button-secondary"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(link);
                onToast(language === "ar" ? "تم نسخ الرابط" : "Link copied");
              } catch {
                onToast(
                  language === "ar"
                    ? "حدد الرابط وانسخه يدويًا"
                    : "Select and copy the link manually",
                );
              }
            }}
          >
            {t.copy}
          </button>
        </div>
        <a
          className="button button-primary"
          href={`${trackingBase}${receipt.trackingToken}`}
        >
          {t.track}
        </a>
        <p>{t.manual}</p>
        <p className="request-muted">{t.warning}</p>
      </div>
    );
  }
  return (
    <>
      <div className="request-intro">
        <p className="eyebrow">
          {language === "ar"
            ? "العيادة · دون حساب"
            : "ONE CLINIC · NO ACCOUNT NEEDED"}
        </p>
        <h1 ref={heading} tabIndex={-1}>
          {t.title}
        </h1>
        <p>{t.intro}</p>
      </div>
      <ol
        className="request-stepper"
        aria-label={language === "ar" ? "خطوات الطلب" : "Request progress"}
      >
        {t.steps.map((label, i) => (
          <li
            key={i}
            aria-current={i === step ? "step" : undefined}
            data-complete={i < step}
          >
            <button
              type="button"
              disabled={i > step || busy}
              onClick={() => {
                setStep(i);
                setMessage("");
              }}
            >
              <span>{i < step ? "✓" : i + 1}</span>
              {label}
            </button>
          </li>
        ))}
      </ol>
      <div className="request-layout">
        <section className="request-card">
          <h2>{step === 0 ? t.choose : step === 1 ? t.details : t.review}</h2>
          <p className="request-muted">{step === 0 ? t.noCount : t.privacy}</p>
          {message && (
            <div className="request-alert is-error" role="alert">
              {message}
            </div>
          )}
          <form onSubmit={step === 2 ? submit : advance} noValidate>
            <fieldset disabled={busy} className="request-fields">
              <legend className="visually-hidden">{t.steps[step]}</legend>
              {step === 0 && (
                <>
                  <ProfessionalCombobox
                    professionals={PROFESSIONALS}
                    value={professional}
                    onChange={(v) => {
                      setProfessional(v);
                      setSelected("");
                    }}
                    language={language}
                  />
                  <DateField
                    label={t.date}
                    value={date}
                    onChange={(v) => {
                      setDate(v);
                      setSelected("");
                    }}
                    language={language}
                  />
                  {scenario === "loading" ? (
                    <p role="status" className="request-alert">
                      {language === "ar"
                        ? "جارٍ تحميل الجلسات…"
                        : "Loading published sessions…"}
                    </p>
                  ) : scenario === "unavailable" ? (
                    <div className="request-alert is-error" role="alert">
                      {language === "ar"
                        ? "الجلسات غير متاحة مؤقتًا. حاول مجددًا."
                        : "Sessions are temporarily unavailable. Try again."}
                    </div>
                  ) : (
                    professional &&
                    (matching.length ? (
                      <div
                        className="request-session-options"
                        role="group"
                        aria-label={t.choose}
                      >
                        {matching.map((s) => (
                          <label
                            key={s.id}
                            className={`request-session-option ${selected === s.id ? "is-selected" : ""}`}
                          >
                            <input
                              type="radio"
                              name="preview-session"
                              value={s.id}
                              checked={selected === s.id}
                              onChange={() => setSelected(s.id)}
                            />
                            <span>
                              <strong dir="ltr">
                                {s.startTime}–{s.endTime}
                              </strong>
                              <small>
                                {language === "ar"
                                  ? "فترة حضور كاملة · العيادة"
                                  : "Full attendance window · Clinic"}
                              </small>
                              {s.appointmentRequired && (
                                <small>
                                  {language === "ar"
                                    ? "يتطلب حجزًا مسبقًا. لا يُسمح بالدخول دون حجز."
                                    : "Appointment required. Walk-ins prohibited."}
                                </small>
                              )}
                            </span>
                            <span
                              className="request-selection-mark"
                              aria-hidden="true"
                            >
                              {selected === s.id ? "✓" : ""}
                            </span>
                          </label>
                        ))}
                      </div>
                    ) : (
                      <div className="request-alert" role="status">
                        <h3>{t.noSessions}</h3>
                        <p>
                          {preview
                            ? language === "ar"
                              ? "اختر تاريخًا أو أخصائيًا آخر. بيانات العرض: ٢–٤ نوفمبر ٢٠٢٦."
                              : "Choose another date or professional. Preview dates: November 2–4, 2026."
                            : language === "ar"
                              ? "اختر تاريخًا أو أخصائيًا آخر."
                              : "Choose another date or professional."}
                        </p>
                      </div>
                    ))
                  )}
                </>
              )}
              {step === 1 && (
                <>
                  {sample && (
                    <button
                      className="request-text-button"
                      type="button"
                      onClick={() => {
                        setDetails({
                          ...sample,
                          preferredLanguage: language,
                        });
                        setPhoneKey((k) => k + 1);
                        setErrors({});
                        setMessage("");
                      }}
                    >
                      {t.sample}
                    </button>
                  )}
                  <div className="request-form-grid">
                    {[
                      ["firstName", t.first],
                      ["fatherName", t.father],
                      ["lastName", t.last],
                      ["motherFirstName", t.mother],
                    ].map(([key, label]) => (
                      <div className="request-field" key={key}>
                        <label htmlFor={`${id}-${key}`}>{label}</label>
                        <input
                          id={`${id}-${key}`}
                          value={details[key]}
                          maxLength={80}
                          onChange={(e) => edit(key, e.target.value)}
                          aria-invalid={Boolean(errors[key])}
                          aria-describedby={
                            errors[key] ? `${id}-${key}-error` : undefined
                          }
                          autoComplete="off"
                        />
                        {errors[key] && (
                          <p
                            id={`${id}-${key}-error`}
                            className="request-error"
                          >
                            {errors[key]}
                          </p>
                        )}
                      </div>
                    ))}
                    <DateField
                      label={t.dob}
                      value={details.dateOfBirth}
                      onChange={(v) => edit("dateOfBirth", v)}
                      dob
                      language={language}
                      error={errors.dateOfBirth}
                    />
                    <div className="request-field">
                      <label htmlFor={`${id}-gender`}>{t.gender}</label>
                      <select
                        id={`${id}-gender`}
                        value={details.gender}
                        onChange={(e) => edit("gender", e.target.value)}
                        aria-invalid={Boolean(errors.gender)}
                      >
                        <option value="" disabled>
                          {t.empty}
                        </option>
                        <option value="female">{t.female}</option>
                        <option value="male">{t.male}</option>
                      </select>
                      {errors.gender && (
                        <p className="request-error">{errors.gender}</p>
                      )}
                    </div>
                  </div>
                  <RequestPhone
                    key={phoneKey}
                    value={details.phone}
                    onChange={(v) => edit("phone", v)}
                    language={language}
                    error={errors.phone}
                  />
                  <div className="request-field">
                    <label htmlFor={`${id}-language`}>{t.language}</label>
                    <select
                      id={`${id}-language`}
                      value={details.preferredLanguage}
                      onChange={(e) => {
                        edit("preferredLanguage", e.target.value);
                        onLanguage(e.target.value);
                      }}
                    >
                      <option value="en">English</option>
                      <option value="ar">العربية</option>
                    </select>
                  </div>
                </>
              )}
              {step === 2 && (
                <>
                  <SessionSummary
                    session={session}
                    language={language}
                    professional={professionalFor(session)}
                  />
                  <button
                    className="request-text-button"
                    type="button"
                    onClick={() => setStep(0)}
                  >
                    {t.change} {t.steps[0]}
                  </button>
                  <dl className="request-review-grid">
                    {[
                      [t.first, details.firstName],
                      [t.father, details.fatherName],
                      [t.last, details.lastName],
                      [t.mother, details.motherFirstName],
                      [t.dob, details.dateOfBirth],
                      [language === "ar" ? "الهاتف" : "Phone", details.phone],
                      [
                        t.gender,
                        details.gender === "female" ? t.female : t.male,
                      ],
                      [
                        t.language,
                        details.preferredLanguage === "ar"
                          ? "العربية"
                          : "English",
                      ],
                    ].map(([label, value]) => (
                      <div key={label}>
                        <dt>{label}</dt>
                        <dd>
                          <bdi>{value}</bdi>
                        </dd>
                      </div>
                    ))}
                  </dl>
                  <button
                    className="request-text-button"
                    type="button"
                    onClick={() => setStep(1)}
                  >
                    {t.change} {t.details}
                  </button>
                  <div className="request-alert">
                    <strong>{t.pending}</strong>
                    <p>{t.warning}</p>
                  </div>
                </>
              )}
            </fieldset>
            <div className="request-actions">
              {step > 0 && (
                <button
                  className="button button-secondary"
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setStep(step - 1);
                    setMessage("");
                  }}
                >
                  {t.back}
                </button>
              )}
              <button
                className="button button-primary"
                type="submit"
                disabled={
                  busy || (step === 0 && (scenario !== "ready" || !session))
                }
              >
                {busy
                  ? language === "ar"
                    ? "جارٍ الإرسال…"
                    : "Submitting…"
                  : step === 2
                    ? t.submit
                    : t.next}
                <span aria-hidden="true">{language === "ar" ? "←" : "→"}</span>
              </button>
            </div>
          </form>
        </section>
        <aside className="request-card request-aside">
          <p className="eyebrow">
            {language === "ar" ? "معلومات الطلب" : "YOUR REQUEST"}
          </p>
          <h2>{t.attendance}</h2>
          {session ? (
            <SessionSummary
              session={session}
              language={language}
              professional={professionalFor(session)}
            />
          ) : (
            <div className="request-empty-selection">
              <SpecialtyIcon
                specialty={
                  PROFESSIONALS.find((p) => p.id === professional)?.specialty ??
                  ""
                }
              />
              <p>{t.pick}</p>
            </div>
          )}
          <hr />
          <strong>{t.pending}</strong>
          <p>{t.warning}</p>
          <p className="request-muted">{t.manual}</p>
        </aside>
      </div>
    </>
  );
}
