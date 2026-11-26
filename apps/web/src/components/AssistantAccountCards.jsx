import { useEffect, useRef, useState } from "react";
import { accountRequest } from "../patient-account-client.js";
import CancellationForm, {
  cancellationUnavailable,
} from "./CancellationForm.jsx";

const statusText = {
  awaiting: ["Pending", "قيد المراجعة"],
  confirmed: ["Confirmed", "مؤكّد"],
  rejected: ["Declined", "مرفوض"],
  cancelled: ["Cancelled", "ملغى"],
  cancelled_by_patient: ["Cancelled by patient", "ألغاه المريض"],
  attended: ["Attended", "تمّ الحضور"],
};
export const bookingStatus = (status, ar) =>
  statusText[status]?.[ar ? 1 : 0] ?? "";

function BookingSummary({ record, profile, ar, confirmation = false }) {
  const date = new Date(record.date + "T00:00:00Z");
  const day = Number.isNaN(date.getTime())
    ? record.date
    : new Intl.DateTimeFormat(ar ? "ar-LB" : "en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
        timeZone: "UTC",
      }).format(date);
  return (
    <div className="cedar-booking-summary">
      {/dentistry|أسنان/u.test(record.specialty?.toLowerCase() ?? "") && (
        <span className="cedar-booking-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 5.1c2.4-2.3 6.5-2.6 8.1 1 1.5 3.1-.4 5.7-1.5 8.3-1 2.4-1 6.1-2.7 6.1-1.5 0-1.5-4.8-3.9-4.8s-2.4 4.8-3.9 4.8c-1.7 0-1.7-3.7-2.7-6.1C4.3 11.8 2.4 9.2 3.9 6.1c1.6-3.6 5.7-3.3 8.1-1Zm0 0c.8.7 1.5 1.2 2.4 1.3" />
          </svg>
        </span>
      )}
      <div>
        <strong dir="auto">{record.professional}</strong>
        {record.specialty && <div dir="auto">{record.specialty}</div>}
        <div><bdi>{day} · {record.startTime}–{record.endTime}</bdi>{confirmation && (ar ? " · بتوقيت بيروت" : " · Beirut time")}</div>
        {confirmation && <div dir="auto">{profile}</div>}
      </div>
    </div>
  );
}

function BookingCancellationDialog({ record, profile, ar, submit, onClose }) {
  const dialog = useRef(null);
  const [closing, setClosing] = useState(false);
  useEffect(() => {
    dialog.current.showModal();
  }, []);
  const finish = () => {
    dialog.current.close();
    onClose();
  };
  const dismiss = () => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) finish();
    else setClosing(true);
  };
  return (
    <dialog
      ref={dialog}
      className="cedar-cancellation-dialog"
      data-closing={closing || undefined}
      aria-labelledby="cedar-cancellation-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!dialog.current.querySelector("fieldset")?.disabled) dismiss();
      }}
      onAnimationEnd={(event) => {
        if (event.target !== event.currentTarget || !closing) return;
        finish();
      }}
    >
      <h3 id="cedar-cancellation-title">{ar ? "تأكيد الإلغاء" : "Confirm cancellation"}</h3>
      <div className="cedar-cancellation-content">
        <BookingSummary record={record} profile={profile} ar={ar} confirmation />
        <CancellationForm
          ar={ar}
          inDialog
          onBack={dismiss}
          submit={async (confirmation) => {
            await submit(confirmation);
            dismiss();
          }}
        />
      </div>
    </dialog>
  );
}

export default function AssistantAccountCards({
  intent,
  account,
  preferredProfileId,
  language,
  onExpire,
}) {
  const ar = language === "ar";
  const t = (en, arabic) => (ar ? arabic : en);
  const [profiles, setProfiles] = useState(null);
  const [selected, select] = useState(null);
  const [records, setRecords] = useState(null);
  const [error, setError] = useState(false);
  const [ready, setReady] = useState(false);
  const [cancelling, setCancelling] = useState(null);
  const reports = intent === "my_results";

  useEffect(() => {
    const abort = new AbortController();
    if (!account || ["where_results", "sign_in"].includes(intent)) return;
    (async () => {
      try {
        const session = await accountRequest(
          "session",
          undefined,
          abort.signal,
        );
        if (!session.account || session.account.email !== account.email) {
          if (!abort.signal.aborted) onExpire();
          return;
        }
        setReady(true);
        const result = await accountRequest(
          "family-profiles",
          {},
          abort.signal,
        );
        if (abort.signal.aborted) return;
        setProfiles(result.profiles);
        if (result.profiles.some((p) => p.id === preferredProfileId))
          select(preferredProfileId);
        else if (result.profiles.length === 1) select(result.profiles[0].id);
      } catch (failure) {
        if (abort.signal.aborted) return;
        if (failure.code === "sign_in_required") onExpire();
        else setError(true);
      }
    })();
    async function checkSession() {
      try {
        const { account: current } = await accountRequest(
          "session",
          undefined,
          abort.signal,
        );
        if (!abort.signal.aborted && current?.email !== account.email)
          onExpire();
      } catch {
        if (!abort.signal.aborted) onExpire();
      }
    }
    window.addEventListener("focus", checkSession);
    const timer = setInterval(checkSession, 30_000);
    return () => {
      abort.abort();
      clearInterval(timer);
      window.removeEventListener("focus", checkSession);
    };
  }, [account, intent, preferredProfileId, onExpire]);

  useEffect(() => {
    if (!selected) return;
    const abort = new AbortController();
    const action = reports ? "lab-reports" : "profile-requests";
    const key = reports ? "patientId" : "profileId";
    accountRequest(action, { [key]: selected }, abort.signal).then(
      (data) => {
        if (!abort.signal.aborted)
          setRecords(reports ? data.reports : data.requests);
      },
      (failure) => {
        if (abort.signal.aborted) return;
        if (failure.code === "sign_in_required") onExpire();
        else setError(true);
      },
    );
    return () => abort.abort();
  }, [selected, reports, onExpire]);

  const label = (p) => (p.relationship === "self" ? t("Me", "أنا") : p.name);
  const profile = profiles?.find((p) => p.id === selected);
  if (intent === "where_results")
    return (
      <a href="/account#lab-results">
        {t("Open Lab results in My account", "افتح نتائج المختبر في حسابي")}
      </a>
    );
  if (intent === "sign_in" && account)
    return <a href="/account">{t("Open My account", "افتح حسابي")}</a>;
  if (!account)
    return (
      <>
        <a href="/account">{t("Sign in", "تسجيل الدخول")}</a>
        {intent === "cancel_request" && (
          <a href="/cancel">{t("Guest cancellation", "إلغاء موعد الضيف")}</a>
        )}
      </>
    );
  if (error)
    return (
      <p role="alert">
        {t("Contact Reception for help.", "تواصل مع استقبال سيدر للمساعدة.")}
      </p>
    );
  if (!ready || !profiles)
    return (
      <p role="status">
        {t("Checking your account…", "جارٍ التحقق من حسابك…")}
      </p>
    );
  return (
    <section
      aria-label={
        reports
          ? t("Released Lab reports", "نتائج المختبر الصادرة")
          : t("My bookings", "حجوزاتي")
      }
    >
      <h3 className="cedar-assistant-account-title">
        {reports ? t("My results", "نتائجي") : t("My bookings", "حجوزاتي")}
      </h3>
      {profiles.length > 1 && (
        <div className="cedar-assistant-account-profiles">
          {profiles.map((p) => (
            <button
              type="button"
              key={p.id}
              aria-pressed={selected === p.id}
              onClick={() => {
                if (selected === p.id) return;
                setRecords(null);
                setCancelling(null);
                select(p.id);
              }}
            >
              {label(p)}
            </button>
          ))}
        </div>
      )}
      {!profile && (
        <p>
          {profiles.length
            ? t("Choose a profile.", "اختر ملفًا.")
            : t("No linked profile is available.", "لا يوجد ملف مرتبط.")}
        </p>
      )}
      {profile && records === null && (
        <p role="status">{t("Loading…", "جارٍ التحميل…")}</p>
      )}
      {records?.length === 0 && (
        <p>
          {reports
            ? t("No released reports.", "لا توجد نتائج صادرة.")
            : t("No booking requests.", "لا توجد طلبات مواعيد.")}
        </p>
      )}
      {!!records?.length && (
        <ul className="cedar-assistant-account-records">
          {records.map((record) =>
            reports ? (
              <li key={record.id} className="cedar-assistant-account-card">
                <bdi>
                  {record.orderNumber} · {String(record.date).slice(0, 10)} ·{" "}
                  {label(profile)}
                </bdi>{" "}
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={async () => {
                    try {
                      const blob = await accountRequest("lab-report", {
                        patientId: selected,
                        reportId: record.id,
                      });
                      const url = URL.createObjectURL(blob);
                      const link = document.createElement("a");
                      link.href = url;
                      link.download = "cedar-report.pdf";
                      link.click();
                      setTimeout(() => URL.revokeObjectURL(url), 1000);
                    } catch (failure) {
                      if (failure.code === "sign_in_required") onExpire();
                      else setError(true);
                    }
                  }}
                >
                  {t("Download PDF", "تنزيل PDF")}
                </button>
              </li>
            ) : (
              <li key={record.reference} className="cedar-assistant-account-card">
                <div className="cedar-booking-top">
                  <BookingSummary record={record} profile={label(profile)} ar={ar} />
                  {bookingStatus(record.status, ar) && (
                    <span className="cedar-booking-status" data-status={record.status}>
                      {bookingStatus(record.status, ar)}
                    </span>
                  )}
                </div>
                {record.cancellation?.reason &&
                  !["cancelled", "cancelled_by_patient"].includes(
                    record.status,
                  ) && (
                    <p>
                      {cancellationUnavailable(record.cancellation.reason, ar)}
                    </p>
                  )}
                {cancelling === record.reference && (
                  <BookingCancellationDialog
                    record={record}
                    profile={label(profile)}
                    ar={ar}
                    onClose={() => setCancelling(null)}
                    submit={async (confirmation) => {
                      try {
                        await accountRequest("cancel-booking", {
                          profileId: selected,
                          reference: record.reference,
                          ...confirmation,
                        });
                      } catch (failure) {
                        if (failure.code === "sign_in_required") onExpire();
                        throw failure;
                      }
                      setRecords((current) =>
                        current.map((r) =>
                          r.reference === record.reference
                            ? {
                                ...r,
                                status: "cancelled_by_patient",
                                cancellation: { eligible: false },
                              }
                            : r,
                        ),
                      );
                    }}
                  />
                )}
                {record.cancellation?.eligible && (
                    <button
                      type="button"
                      className="button button-secondary cedar-booking-cancel"
                      onClick={() => setCancelling(record.reference)}
                    >
                      {t("Cancel booking", "إلغاء الموعد")}
                    </button>
                )}
              </li>
            ),
          )}
        </ul>
      )}
    </section>
  );
}
