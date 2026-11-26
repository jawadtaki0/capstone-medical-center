import { useEffect, useState } from "react";
import CancellationForm from "../components/CancellationForm.jsx";
import { accountRequest } from "../patient-account-client.js";

export default function GuestCancellationPage() {
  const [proof] = useState(() => window.location.hash.slice(1));
  const [arabic, setArabic] = useState(document.documentElement.lang === "ar");
  const [request, setRequest] = useState(null);
  const [status, setStatus] = useState(proof ? "loading" : "no-link");
  const t = (en, ar) => (arabic ? ar : en);
  useEffect(() => {
    if (!proof) return;
    const controller = new AbortController();
    accountRequest("guest-cancellation", { proof }, controller.signal).then(
      (data) => {
        if (controller.signal.aborted) return;
        setRequest(data);
        setStatus("ready");
      },
      () => {
        if (!controller.signal.aborted) setStatus("unavailable");
      },
    );
    return () => controller.abort();
  }, [proof]);

  return (
    <main
      className="container request-shell"
      dir={arabic ? "rtl" : "ltr"}
      lang={arabic ? "ar" : "en"}
    >
      <h1>{t("Guest booking cancellation", "إلغاء موعد الضيف")}</h1>
      <button type="button" onClick={() => setArabic(!arabic)}>
        {arabic ? "English" : "العربية"}
      </button>
      {status === "loading" && (
        <p role="status">{t("Checking the link…", "جارٍ التحقق من الرابط…")}</p>
      )}
      {status === "no-link" && (
        <p>
          {t(
            "Open your private tracking link and select Cancel booking, or contact Cedar Reception.",
            "افتح رابط المتابعة الخاص بك واختر إلغاء الموعد، أو تواصل مع استقبال سيدر.",
          )}
        </p>
      )}
      {status === "unavailable" && (
        <p>
          {t(
            "This link is unavailable. Contact Cedar Reception for help.",
            "هذا الرابط غير متاح. تواصل مع استقبال سيدر للمساعدة.",
          )}
        </p>
      )}
      {status === "done" && (
        <p role="status">
          {t(
            "Your booking was cancelled at your request.",
            "أُلغي موعدك بناءً على طلبك.",
          )}
        </p>
      )}
      {status === "ready" && (
        <>
          <p>
            <bdi>
              {request.professional} · {request.date} · {request.startTime}–
              {request.endTime}
            </bdi>{" "}
            · {t("Beirut time", "بتوقيت بيروت")}
          </p>
          {request.cancellation.eligible ? (
            <CancellationForm
              ar={arabic}
              submit={async (confirmation) => {
                await accountRequest("guest-cancel-booking", {
                  proof,
                  ...confirmation,
                });
                history.replaceState(null, "", location.pathname);
                setRequest(null);
                setStatus("done");
              }}
            />
          ) : (
            <p>
              {t(
                "Online cancellation is unavailable for this booking. Contact Cedar Reception.",
                "لا يمكن إلغاء هذا الموعد عبر الإنترنت. تواصل مع استقبال سيدر.",
              )}
            </p>
          )}
        </>
      )}
    </main>
  );
}
