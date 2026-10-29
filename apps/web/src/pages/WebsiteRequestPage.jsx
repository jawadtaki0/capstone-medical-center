import { useEffect, useRef, useState } from "react";
import GrainientPage from "../components/GrainientPage.jsx";
import RequestForm from "../request-preview/RequestForm.jsx";
import TrackingView from "../request-preview/TrackingView.jsx";
import { createRequestClient } from "../website-request-client.js";
import "../components/doctorDirectory.css";
import "../request-preview/preview.css";
const hostedReview = import.meta.env.VITE_HOSTED_REVIEW === "1";
const apiOrigin = hostedReview ? import.meta.env.VITE_REVIEW_API_ORIGIN : "";
if (hostedReview && !apiOrigin)
  throw Error("Hosted review API origin is required.");
const api = createRequestClient({ apiOrigin });
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
      new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Beirut",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date()),
    );
  useEffect(() => {
    let stopped = false,
      timer;
    const controller = new AbortController(),
      version = ++generation.current;
    async function load() {
      if (document.hidden) {
        timer = setTimeout(load, 30000);
        return;
      }
      try {
        const result = tracking
          ? await api(
              "track",
              { token: window.location.hash.slice(1) },
              controller.signal,
            )
          : await api(
              `sessions?date=${encodeURIComponent(date)}`,
              null,
              controller.signal,
            );
        if (stopped || version !== generation.current) return;
        if (tracking) setData(result);
        else {
          setSessions(result.map((s) => ({ ...s, id: s.sourceSessionId })));
          const list = await api(
            `professionals?date=${encodeURIComponent(date)}`,
            null,
            controller.signal,
          );
          if (!stopped && version === generation.current)
            setProfessionals(
              list.map((p) => ({ ...p, gender: p.avatarVariant })),
            );
        }
        setError("");
        setScenario("ready");
      } catch (e) {
        if (!stopped && version === generation.current) {
          if (tracking) setData(null);
          setError(e.forLanguage?.(language) ?? e.message);
          setScenario("unavailable");
        }
      }
      if (tracking && !stopped) timer = setTimeout(load, 30000);
    }
    void load();
    return () => {
      stopped = true;
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
    <GrainientPage>
      <div className="container request-shell">
        <div className="request-alert" role="note">
          {hostedReview
            ? language === "ar"
              ? "عرض تجريبي فقط — استخدم بيانات مرضى وهمية. لا ترسل بيانات مرضى حقيقيين."
              : "Synthetic review only — use fictional patient details. Do not submit real patient information."
            : "Local review only. Links pointing to localhost work on this computer, not on another device."}
        </div>
        {hostedReview && scenario === "loading" && (
          <p className="request-alert" role="status">
            {language === "ar"
              ? "قد يحتاج خادم العرض المجاني إلى نحو دقيقة لبدء التشغيل. يرجى الانتظار؛ لا حاجة لإرسال طلب جديد."
              : "The free review server may take about a minute to wake. Please wait; there is no need to submit a new request."}
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
              <p role="status">Loading request…</p>
            ) : (
              <TrackingView data={data} onLanguage={setLanguage} />
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
            <label className="request-field">
              Language
              <select
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
                onDateChange={setDate}
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
    </GrainientPage>
  );
}
