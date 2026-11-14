import { useEffect, useId, useRef, useState } from "react";
import { DateField, ProfessionalCombobox } from "./FormControls.jsx";
import PatientDetailsFields, {
  patientDetailsCopy,
} from "./PatientDetailsFields.jsx";
import { patientInput } from "../../../staff/shared/patient-input.js";
import { createSubmissionAttempt } from "../website-request-client.js";
import {
  selectionKey,
  validatedPreselection,
  validatedProfessionalPreselection,
} from "../request-selection.js";
import LoadingStatus from "../components/PublicLoadingStatus.jsx";
function makeSubmissionKey() {
  return btoa(
    String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))),
  )
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
export function currentAvailability(session, now = Date.now()) {
  return Date.parse(session?.availabilityExpiresAt) > now
    ? session.availability
    : "unknown";
}
export function sessionSelectable(session) {
  const state = currentAvailability(session);
  return state !== "full" && state !== "blocked";
}
export function AvailabilityLabel({ session, language }) {
  const state = currentAvailability(session);
  if (state === "full")
    return (
      <small className="request-session-full">
        {language === "ar" ? "⊘ الجلسة ممتلئة" : "⊘ Session full"}
      </small>
    );
  if (state === "blocked")
    return (
      <small>
        {language === "ar"
          ? "غير متاحة للحجز حاليًا"
          : "Not currently bookable"}
      </small>
    );
  return null;
}
export function UnknownAvailabilityExplanation({ language }) {
  return (
    <p className="request-muted" role="status">
      {language === "ar"
        ? "التوفر غير مؤكد حاليًا. يمكنك إرسال طلب بانتظار تأكيد الموظف."
        : "Availability is temporarily unconfirmed. You can request this window; staff must confirm a place."}
    </p>
  );
}
import SpecialtyIcon from "../components/SpecialtyIcon.jsx";
import ProfessionalAvatar from "../components/ProfessionalAvatar.jsx";

const copy = {
  en: {
    ...patientDetailsCopy.en,
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
    language: "Preferred language",
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
    ...patientDetailsCopy.ar,
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
    language: "اللغة المفضلة",
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
  loadUpcoming,
  preselectionSearch = "",
  bookingProfile,
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
    [availabilityNow, setAvailabilityNow] = useState(Date.now),
    [professional, setProfessional] = useState(""),
    [date, setDate] = useState(initialDate),
    [selected, setSelected] = useState(""),
    [chosenSession, setChosenSession] = useState(null),
    [discovery, setDiscovery] = useState({ status: "idle", sessions: [] }),
    [earlierPages, setEarlierPages] = useState([]),
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
  const discoveryStatus =
    discovery.professionalId === professional ? discovery.status : "loading";
  const discoveryVersion = useRef(0),
    discoveryController = useRef(null),
    preselectionApplied = useRef(false);
  const submissionAttempt = useRef(createSubmissionAttempt(makeSubmissionKey)),
    session =
      selected && selectionKey(chosenSession) === selected
        ? chosenSession
        : null,
    matching =
      scenario === "empty"
        ? []
        : SESSIONS.filter(
            (s) => s.professionalId === professional && s.date === date,
          );
  useEffect(() => {
    const refreshClock = () => setAvailabilityNow(Date.now());
    const deadlines = [...SESSIONS, ...discovery.sessions, chosenSession]
      .map((s) => Date.parse(s?.availabilityExpiresAt))
      .filter((at) => at > availabilityNow);
    const next = Math.min(...deadlines);
    const timer = Number.isFinite(next)
      ? setTimeout(
          refreshClock,
          Math.max(1, Math.min(next - Date.now(), 2147483647)),
        )
      : null;
    document.addEventListener("visibilitychange", refreshClock);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", refreshClock);
    };
  }, [SESSIONS, discovery.sessions, chosenSession, availabilityNow]);
  function chooseSession(s) {
    if (!sessionSelectable(s)) return;
    setChosenSession(s);
    setSelected(selectionKey(s));
    setProfessional(s.professionalId);
    setDate(s.date);
  }
  async function discover(fromDate, after = null, direction = "retry") {
    discoveryController.current?.abort();
    const controller = new AbortController();
    discoveryController.current = controller;
    const version = ++discoveryVersion.current;
    setDiscovery((previous) => ({
      ...(previous.professionalId === professional
        ? previous
        : { sessions: [] }),
      status: "loading",
      requestFrom: fromDate,
      requestAfter: after,
      professionalId: professional,
    }));
    try {
      const result = await loadUpcoming(
        professional,
        fromDate,
        after,
        controller.signal,
      );
      if (
        !alive.current ||
        controller.signal.aborted ||
        version !== discoveryVersion.current
      )
        return;
      if (direction === "later")
        setEarlierPages((pages) => [
          ...pages,
          { fromDate: discovery.requestFrom, after: discovery.requestAfter },
        ]);
      else if (direction === "earlier")
        setEarlierPages((pages) => pages.slice(0, -1));
      setDiscovery({
        ...result,
        status: "ready",
        requestFrom: fromDate,
        requestAfter: after,
        professionalId: professional,
      });
    } catch (error) {
      if (
        !alive.current ||
        controller.signal.aborted ||
        version !== discoveryVersion.current
      )
        return;
      setDiscovery((previous) => ({
        ...previous,
        status: "unavailable",
        error: error.forLanguage?.(language) ?? error.message,
      }));
    }
  }
  useEffect(() => {
    setEarlierPages([]);
    if (!loadUpcoming || !professional) {
      discoveryController.current?.abort();
      discoveryVersion.current++;
      setDiscovery({ status: "idle", sessions: [] });
      return;
    }
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Beirut",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    void discover(today);
    return () => {
      discoveryVersion.current++;
      discoveryController.current?.abort();
    };
  }, [professional, loadUpcoming]);
  useEffect(() => {
    if (
      preselectionApplied.current ||
      !preselectionSearch ||
      scenario !== "ready"
    )
      return;
    const candidate = validatedPreselection(preselectionSearch, SESSIONS);
    preselectionApplied.current = true;
    if (candidate && sessionSelectable(candidate)) chooseSession(candidate);
    else {
      const parameters = new URLSearchParams(preselectionSearch);
      const p =
        validatedProfessionalPreselection(preselectionSearch, PROFESSIONALS) ??
        (parameters.getAll("professional").length === 1 &&
        parameters.has("session")
          ? PROFESSIONALS.find((p) => p.id === parameters.get("professional"))
          : null);
      if (p) setProfessional(p.id);
      if (new URLSearchParams(preselectionSearch).has("session")) {
        setMessage(
          language === "ar"
            ? "الجلسة المختارة انتهت أو تغيّرت أو لم تعد متاحة. اختر جلسة منشورة أخرى."
            : "The linked session has ended, changed or is unavailable. Please choose another published session.",
        );
      }
    }
  }, [scenario, SESSIONS, PROFESSIONALS, preselectionSearch]);
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
      if (
        !session ||
        session.professionalId !== professional ||
        session.date !== date
      ) {
        setMessage(t.pick);
        return;
      }
      setStep(1);
    } else if (step === 1) {
      const { preferredLanguage, ...record } = details;
      const problems = bookingProfile
        ? {}
        : patientInput(
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
      if (alive.current) {
        setMessage(e.forLanguage?.(language) ?? e.message);
        if (e.code === "session_unavailable") {
          setChosenSession(null);
          setSelected("");
          setStep(0);
          if (loadUpcoming)
            void discover(
              new Intl.DateTimeFormat("en-CA", {
                timeZone: "Asia/Beirut",
                year: "numeric",
                month: "2-digit",
                day: "2-digit",
              }).format(new Date()),
            );
        }
      }
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
        <p className="request-receipt-status">{t.awaiting}</p>
        <h1 ref={heading} tabIndex={-1}>
          {t.receipt}
        </h1>
        <p>
          {language === "ar" ? "مرجع الطلب" : "Request reference"}:{" "}
          <strong className="request-reference" dir="ltr">
            {receipt.reference}
          </strong>
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
            : "Clinic requests · no account needed"}
        </p>
        <h1>{t.title}</h1>
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
          {session && scenario !== "ready" && (
            <p className="request-muted" role="status">
              {language === "ar"
                ? "هذا آخر اختيار لك. الجلسات المنشورة غير متاحة حاليًا."
                : "This is your last selected session. Published sessions are currently unavailable."}
            </p>
          )}
          {session && step > 0 && (
            <button
              className="text-button request-change-selection"
              type="button"
              disabled={busy}
              onClick={() => {
                setStep(0);
                setMessage("");
              }}
            >
              {language === "ar" ? "تغيير الاختيار" : "Change selection"}
            </button>
          )}
          <hr />
          <strong>{t.pending}</strong>
          <p>{t.warning}</p>
          <p className="request-muted">{t.manual}</p>
        </aside>
        <section className="request-card request-form-panel">
          <h2 ref={heading} tabIndex={-1} className="request-step-heading">
            {step === 0 ? t.choose : step === 1 ? t.details : t.review}
          </h2>
          <p className="request-muted">
            {step === 0
              ? t.noCount
              : bookingProfile
                ? language === "ar"
                  ? "يراجع الاستقبال الطلب قبل تأكيد الحجز."
                  : "Reception reviews the request before confirming a booking."
                : t.privacy}
          </p>
          {step === 0 &&
            professional &&
            [...matching, ...discovery.sessions].some(
              (s) =>
                s.professionalId === professional &&
                currentAvailability(s) === "unknown",
            ) && <UnknownAvailabilityExplanation language={language} />}
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
                    status={scenario === "empty" ? "ready" : scenario}
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
                  {loadUpcoming && professional && (
                    <section
                      className="request-upcoming"
                      aria-label={
                        language === "ar"
                          ? "الجلسات المنشورة القادمة"
                          : "Next published sessions"
                      }
                    >
                      <h3>
                        {language === "ar"
                          ? "الجلسات المنشورة القادمة"
                          : "Next published sessions"}
                      </h3>
                      {discoveryStatus === "loading" && (
                        <LoadingStatus
                          wakeHint
                          language={language}
                          label={
                            language === "ar"
                              ? "جارٍ تحميل المواعيد المنشورة…"
                              : "Loading published dates and windows…"
                          }
                        />
                      )}
                      {discoveryStatus === "unavailable" && (
                        <div role="alert" className="request-alert is-error">
                          {discovery.error}
                          <button
                            type="button"
                            className="request-text-button"
                            onClick={() =>
                              discover(
                                discovery.requestFrom ?? initialDate,
                                discovery.requestAfter ?? null,
                              )
                            }
                          >
                            {language === "ar"
                              ? "أعد المحاولة"
                              : "Retry upcoming sessions"}
                          </button>
                        </div>
                      )}
                      {discovery.fromDate &&
                        discovery.professionalId === professional && (
                          <>
                            <p className="request-muted">
                              <bdi>
                                {discovery.fromDate} – {discovery.throughDate}
                              </bdi>{" "}
                              ·{" "}
                              {language === "ar"
                                ? "بتوقيت بيروت. هذه صفحة نتائج وليست حدًا للحجز."
                                : "Asia/Beirut. This is a results page, not a booking horizon."}
                            </p>
                            {!discovery.sessions.length && (
                              <p role="status">
                                {language === "ar"
                                  ? "لا جلسات في هذه الفترة. ابحث لاحقًا أو اختر تاريخًا آخر."
                                  : "No sessions in this period. Look further or browse another date."}
                              </p>
                            )}
                            <div className="request-session-options">
                              {discovery.sessions.map((s) => (
                                <button
                                  type="button"
                                  key={selectionKey(s)}
                                  className={`request-session-option ${selected === selectionKey(s) ? "is-selected" : ""}`}
                                  aria-pressed={selected === selectionKey(s)}
                                  disabled={
                                    discoveryStatus !== "ready" ||
                                    !sessionSelectable(s)
                                  }
                                  onClick={() => chooseSession(s)}
                                >
                                  <span>
                                    <strong>
                                      <bdi>
                                        {s.date} · {s.startTime}–{s.endTime}
                                      </bdi>
                                    </strong>
                                    <small>{s.professionalName}</small>
                                    <AvailabilityLabel
                                      session={s}
                                      language={language}
                                    />
                                    {s.appointmentRequired && (
                                      <small>
                                        {language === "ar"
                                          ? "يتطلب حجزًا مسبقًا. لا يُسمح بالدخول دون حجز."
                                          : "Appointment required. Walk-ins prohibited."}
                                      </small>
                                    )}
                                  </span>
                                </button>
                              ))}
                            </div>
                            <div className="request-actions">
                              <button
                                type="button"
                                className="request-text-button"
                                aria-disabled={
                                  !earlierPages.length ||
                                  discoveryStatus !== "ready"
                                }
                                onClick={() => {
                                  if (discoveryStatus !== "ready") return;
                                  const previous = earlierPages.at(-1);
                                  if (previous)
                                    void discover(
                                      previous.fromDate,
                                      previous.after,
                                      "earlier",
                                    );
                                }}
                              >
                                {language === "ar"
                                  ? "جلسات سابقة"
                                  : "Earlier sessions"}
                              </button>
                              {discovery.nextDate && (
                                <button
                                  type="button"
                                  className="request-text-button"
                                  aria-disabled={discoveryStatus !== "ready"}
                                  onClick={() => {
                                    if (discoveryStatus !== "ready") return;
                                    void discover(
                                      discovery.nextDate,
                                      discovery.nextAfter,
                                      "later",
                                    );
                                  }}
                                >
                                  {language === "ar"
                                    ? "البحث في الفترة التالية"
                                    : "Later sessions"}
                                </button>
                              )}
                            </div>
                          </>
                        )}
                    </section>
                  )}
                  {scenario === "loading" ? (
                    <LoadingStatus
                      wakeHint
                      language={language}
                      label={
                        language === "ar"
                          ? "جارٍ تحميل الجلسات…"
                          : "Loading published sessions…"
                      }
                    />
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
                            key={selectionKey(s)}
                            className={`request-session-option ${selected === selectionKey(s) ? "is-selected" : ""}`}
                          >
                            <input
                              type="radio"
                              name="preview-session"
                              value={selectionKey(s)}
                              checked={selected === selectionKey(s)}
                              disabled={!sessionSelectable(s)}
                              onChange={() => chooseSession(s)}
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
                              <AvailabilityLabel
                                session={s}
                                language={language}
                              />
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
                              {selected === selectionKey(s) ? "✓" : ""}
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
                  {bookingProfile ? (
                    <p>
                      <bdi>
                        {bookingProfile.firstName} {bookingProfile.lastName}
                      </bdi>
                    </p>
                  ) : (
                    <PatientDetailsFields
                      details={details}
                      edit={edit}
                      errors={errors}
                      language={language}
                      phoneKey={phoneKey}
                    />
                  )}
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
                    {(bookingProfile
                      ? [
                          [
                            t.details,
                            `${bookingProfile.firstName} ${bookingProfile.lastName}`,
                          ],
                          [
                            language === "ar" ? "الهاتف" : "Phone",
                            bookingProfile.phone,
                          ],
                        ]
                      : [
                          [t.first, details.firstName],
                          [t.father, details.fatherName],
                          [t.last, details.lastName],
                          [t.mother, details.motherFirstName],
                          [t.dob, details.dateOfBirth],
                          [
                            language === "ar" ? "الهاتف" : "Phone",
                            details.phone,
                          ],
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
                        ]
                    ).map(([label, value]) => (
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
            {busy && (
              <LoadingStatus
                wakeHint
                language={language}
                label={
                  language === "ar"
                    ? "جارٍ إرسال الطلب…"
                    : "Submitting request…"
                }
              />
            )}
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
      </div>
    </>
  );
}
