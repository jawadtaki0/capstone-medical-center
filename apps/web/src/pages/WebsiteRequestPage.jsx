import { useEffect, useRef, useState } from "react";
import PublicPage from "../components/PublicPage.jsx";
import RequestForm from "../request-preview/RequestForm.jsx";
import TrackingView from "../request-preview/TrackingView.jsx";
import LoadingStatus from "../components/PublicLoadingStatus.jsx";
import { createRequestClient } from "../website-request-client.js";
import {
  createCatalogueLoader,
  preselectionDate,
} from "../request-selection.js";
import "../components/doctorDirectory.css";
import "../request-preview/preview.css";
const capstone = import.meta.env.VITE_HOSTED_CAPSTONE === "1";
const hostedReview = import.meta.env.VITE_HOSTED_REVIEW === "1" || capstone;
const apiOrigin = capstone
  ? import.meta.env.VITE_CAPSTONE_API_ORIGIN
  : hostedReview
    ? import.meta.env.VITE_REVIEW_API_ORIGIN
    : "";
if (hostedReview && !apiOrigin)
  throw Error("Hosted review API origin is required.");
const api = createRequestClient({ apiOrigin });
const upcoming = (professionalId, fromDate, after, signal) =>
  api(
    `upcoming?professionalId=${encodeURIComponent(professionalId)}&fromDate=${encodeURIComponent(fromDate)}${after ? `&after=${encodeURIComponent(after)}` : ""}`,
    null,
    signal,
  );
export default function WebsiteRequestPage({ tracking = false }) {
  const [language, setLanguage] = useState("en"),
    [sessions, setSessions] = useState([]),
    [professionals, setProfessionals] = useState([]),
    [scenario, setScenario] = useState("loading"),
    [error, setError] = useState(""),
    [data, setData] = useState(null),
    [toast, setToast] = useState(""),
    [reload, setReload] = useState(0);
  const generation = useRef(0),
    [date, setDate] = useState(
      preselectionDate(window.location.search) ??
        new Intl.DateTimeFormat("en-CA", {
          timeZone: "Asia/Beirut",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(new Date()),
    );
  const catalogue = useRef(null);
  if (!catalogue.current)
    catalogue.current = createCatalogueLoader(api, (result) => {
      setScenario(result.status);
      if (result.status === "ready") {
        setSessions(
          result.sessions.map((s) => ({ ...s, id: s.sourceSessionId })),
        );
        setProfessionals(
          result.professionals.map((p) => ({ ...p, gender: p.avatarVariant })),
        );
        setError("");
      } else if (result.status === "unavailable")
        setError(result.error.forLanguage?.(language) ?? result.error.message);
    });
  useEffect(() => {
    let stopped = false,
      timer;
    const controller = new AbortController(),
      version = ++generation.current;
    async function load() {
      if (document.hidden) {
        timer = setTimeout(load, 10000);
        return;
      }
      if (!tracking) {
        await catalogue.current.load(date, controller.signal);
        return;
      }
      try {
        const result = await api(
          "track",
          { token: window.location.hash.slice(1) },
          controller.signal,
        );
        if (stopped || version !== generation.current) return;
        setData(result);
        setError("");
        setScenario("ready");
      } catch (e) {
        if (!stopped && version === generation.current) {
          if (tracking) setData(null);
          setError(e.forLanguage?.(language) ?? e.message);
          setScenario("unavailable");
        }
      }
      if (tracking && !stopped) timer = setTimeout(load, 10000);
    }
    void load();
    return () => {
      stopped = true;
      if (!tracking) catalogue.current.cancel();
      controller.abort();
      clearTimeout(timer);
    };
  }, [tracking, date, reload]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 3500);
    return () => clearTimeout(t);
  }, [toast]);
  return (
    <PublicPage
      className={tracking ? "public-tracking-page" : "public-request-page"}
    >
      <div className="container request-shell">
        {hostedReview && scenario === "loading" && (
          <p className="request-alert" role="status">
            {language === "ar"
              ? "قد يكون الخادم قيد التشغيل أو غير متاح مؤقتًا. يرجى الانتظار؛ لا حاجة لإرسال طلب جديد."
              : "The server may be waking or temporarily unavailable. Please wait; there is no need to submit a new request."}
          </p>
        )}
        {error && (
          <div className="request-alert" role="alert">
            {error}{" "}
            <button
              className="button button-secondary"
              onClick={() => setReload((v) => v + 1)}
            >
              Try again
            </button>
          </div>
        )}
        {tracking ? (
          <>
            {scenario === "loading" ? (
              <LoadingStatus
                label={
                  language === "ar" ? "جارٍ تحميل الطلب…" : "Loading request…"
                }
                language={language}
                wakeHint
              />
            ) : (
              <TrackingView
                data={data}
                onLanguage={setLanguage}
                requestHref="/request"
              />
            )}{" "}
            {data?.windowEnded && (
              <p className="request-alert">
                {language === "ar"
                  ? "انتهت فترة الحضور هذه. يرجى الاتصال بالمركز."
                  : "This attendance window has ended. Please contact the center."}
              </p>
            )}
          </>
        ) : (
          <>
            <label
              className="request-field"
              dir={language === "ar" ? "rtl" : "ltr"}
            >
              {language === "ar" ? "لغة الصفحة" : "Page language"}
              <select
                aria-label={language === "ar" ? "لغة الصفحة" : "Page language"}
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
              >
                <option value="en">English</option>
                <option value="ar">العربية</option>
              </select>
            </label>
            <div dir={language === "ar" ? "rtl" : "ltr"} lang={language}>
              <RequestForm
                language={language}
                onLanguage={setLanguage}
                professionals={professionals}
                sessions={sessions}
                scenario={scenario}
                loadUpcoming={upcoming}
                preselectionSearch={window.location.search}
                onDateChange={(value) => {
                  if (value !== date) {
                    setScenario("loading");
                    setDate(value);
                  }
                }}
                initialDate={date}
                onToast={setToast}
                submitRequest={async (
                  patient,
                  session,
                  submissionKey,
                  honeypot,
                ) =>
                  api("submit", {
                    submissionKey,
                    selection: {
                      date: session.date,
                      professionalId: session.professionalId,
                      sourceSessionId: session.sourceSessionId,
                      startTime: session.startTime,
                      endTime: session.endTime,
                    },
                    patient,
                    honeypot,
                  })
                }
              />
            </div>
          </>
        )}
        {toast && (
          <div role="status" className="request-toast">
            {toast}
          </div>
        )}
      </div>
    </PublicPage>
  );
}
