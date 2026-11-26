import { useEffect, useState } from "react";
import { accountRequest } from "../patient-account-client.js";
import "./account-lab-results.css";

export default function AccountLabResults({ language }) {
  const ar = language === "ar";
  const t = (en, arabic) => (ar ? arabic : en);
  const [open, setOpen] = useState(
    () => window.location.hash === "#lab-results",
  );
  const [profiles, setProfiles] = useState([]);
  const [selected, setSelected] = useState("");
  const [results, setResults] = useState(null);
  const [error, setError] = useState("");
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    if (!open) return;
    let live = true;
    accountRequest("family-profiles", {})
      .then(({ profiles }) => {
        if (!live) return;
        setProfiles(profiles);
        setSelected((old) =>
          profiles.some((profile) => profile.id === old)
            ? old
            : (profiles[0]?.id ?? ""),
        );
      })
      .catch(() => {
        if (live) {
          setProfiles([]);
          setSelected("");
          setError(
            ar
              ? "تعذّر تحميل ملفات العائلة."
              : "Family profiles could not be loaded.",
          );
        }
      });
    return () => {
      live = false;
    };
  }, [open, generation, ar]);
  useEffect(() => {
    if (!open || !selected) return;
    let live = true;
    accountRequest("lab-reports", { patientId: selected })
      .then(({ reports }) => {
        if (live) setResults({ patientId: selected, reports });
      })
      .catch(() => {
        if (live) setResults({ patientId: selected, error: true });
      });
    return () => {
      live = false;
    };
  }, [open, selected, generation]);
  if (!open)
    return (
      <button className="button button-secondary" onClick={() => setOpen(true)}>
        {t("Lab results", "نتائج المختبر")}
      </button>
    );
  const visible = results?.patientId === selected ? results : null;
  return (
    <section className="account-lab" id="lab-results">
      <header className="account-lab-title">
        <h2>{t("Lab results", "نتائج المختبر")}</h2>
        <button
          className="text-button"
          onClick={() => {
            setError("");
            setResults(null);
            setGeneration((n) => n + 1);
          }}
        >
          {t("Refresh", "تحديث")}
        </button>
      </header>

      {error && <p role="alert">{error}</p>}
      {profiles.length > 0 && (
        <>
          <div
            className="account-lab-tabs"
            role="tablist"
            aria-label={t("Patient profiles", "ملفات المرضى")}
          >
            {profiles.map((profile, index) => (
              <button
                type="button"
                key={profile.id}
                id={"lab-tab-" + profile.id}
                role="tab"
                aria-selected={selected === profile.id}
                aria-controls="account-lab-results-panel"
                tabIndex={selected === profile.id ? 0 : -1}
                onClick={() => setSelected(profile.id)}
                onKeyDown={(event) => {
                  const step =
                    event.key === "ArrowRight"
                      ? ar
                        ? -1
                        : 1
                      : event.key === "ArrowLeft"
                        ? ar
                          ? 1
                          : -1
                        : 0;
                  if (!step && !["Home", "End"].includes(event.key)) return;
                  event.preventDefault();
                  const next =
                    profiles[
                      event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? profiles.length - 1
                          : (index + step + profiles.length) % profiles.length
                    ];
                  setSelected(next.id);
                  document.getElementById("lab-tab-" + next.id)?.focus();
                }}
              >
                {profile.name}
              </button>
            ))}
          </div>
          <div
            role="tabpanel"
            id="account-lab-results-panel"
            aria-labelledby={"lab-tab-" + selected}
            className="account-lab-table"
          >
            {!visible ? (
              <p role="status">
                {t("Loading reports…", "جارٍ تحميل التقارير…")}
              </p>
            ) : visible.error ? (
              <p role="alert">
                {t(
                  "Reports are unavailable. Refresh to check your current access.",
                  "التقارير غير متاحة. حدّث الصفحة للتحقّق من صلاحية الوصول.",
                )}
              </p>
            ) : !visible.reports.length ? (
              <p>
                {t(
                  "No released reports for this patient.",
                  "لا توجد تقارير صادرة لهذا المريض.",
                )}
              </p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>{t("Report", "التقرير")}</th>
                    <th>{t("Date", "التاريخ")}</th>
                    <th>{t("Status", "الحالة")}</th>
                    <th>{t("PDF", "الملف")}</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.reports.map((report) => (
                    <tr key={report.id}>
                      <td>
                        <bdi>{report.orderNumber}</bdi>
                        {report.corrected && (
                          <div>{t("Corrected report", "تقرير مصحّح")}</div>
                        )}
                      </td>
                      <td>
                        {new Date(report.date).toLocaleDateString(
                          ar ? "ar-LB" : "en",
                          { timeZone: "Asia/Beirut" },
                        )}
                      </td>
                      <td>
                        <span className="account-lab-released">
                          {t("Released", "صادر")}
                        </span>
                      </td>
                      <td>
                        <a
                          className="button button-primary"
                          href={`/api/patient-account/lab-report/${selected}/${report.id}`}
                          download
                          onClick={async (event) => {
                            event.preventDefault();
                            setError("");
                            try {
                              const response = await fetch(
                                "/api/patient-account/lab-report",
                                {
                                  method: "POST",
                                  cache: "no-store",
                                  headers: {
                                    "Content-Type": "application/json",
                                  },
                                  body: JSON.stringify({
                                    patientId: selected,
                                    reportId: report.id,
                                  }),
                                },
                              );
                              if (
                                !response.ok ||
                                response.headers.get("content-type") !==
                                  "application/pdf"
                              )
                                throw Error("Download unavailable");
                              const url = URL.createObjectURL(
                                await response.blob(),
                              );
                              const link = document.createElement("a");
                              link.href = url;
                              link.download =
                                response.headers
                                  .get("content-disposition")
                                  ?.match(/filename="([^"]+)"/)?.[1] ??
                                `${report.orderNumber}.pdf`;
                              link.click();
                              setTimeout(() => URL.revokeObjectURL(url), 1000);
                            } catch {
                              setError(
                                t(
                                  "This report could not be downloaded.",
                                  "تعذّر تنزيل هذا التقرير.",
                                ),
                              );
                            }
                          }}
                        >
                          {t("Download PDF", "تنزيل PDF")}
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </section>
  );
}
