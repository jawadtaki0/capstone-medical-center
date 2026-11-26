import { useState } from "react";

const reasons = [
  [
    "feeling_better",
    "Feeling better or no longer needed",
    "تحسّنت حالتي أو لم أعد بحاجة للموعد",
  ],
  ["schedule_conflict", "Schedule conflict", "تعارض في المواعيد"],
  [
    "booked_elsewhere",
    "Booked another time or doctor",
    "حجزت وقتًا أو طبيبًا آخر",
  ],
  ["going_elsewhere", "Going elsewhere", "سأذهب إلى مكان آخر"],
  ["cost", "Cost", "التكلفة"],
  ["transport", "Transport or travel", "النقل أو السفر"],
  ["other", "Other", "سبب آخر"],
];

export default function CancellationForm({ ar, submit, onBack }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [other, setOther] = useState(false);
  const t = (en, arabic) => (ar ? arabic : en);
  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        if (busy) return;
        const values = new FormData(event.currentTarget);
        setBusy(true);
        setFailed(false);
        try {
          await submit({
            confirmed: true,
            reasons: values.getAll("reasons"),
            note: values.get("note") ?? "",
          });
        } catch {
          setFailed(true);
        } finally {
          setBusy(false);
        }
      }}
    >
      <fieldset disabled={busy}>
        <legend>{t("Confirm cancellation", "تأكيد الإلغاء")}</legend>
        <p>
          {t(
            "The booking cannot be restored. Reasons are optional.",
            "لا يمكن استعادة الموعد. ذكر الأسباب اختياري.",
          )}
        </p>
        {reasons.map(([code, en, arabic]) => (
          <label key={code}>
            <input
              type="checkbox"
              name="reasons"
              value={code}
              onChange={
                code === "other" ? (e) => setOther(e.target.checked) : undefined
              }
            />
            {t(en, arabic)}
          </label>
        ))}
        {other && (
          <label>
            {t("Other reason", "سبب آخر")}{" "}
            <textarea name="note" maxLength={200} />
          </label>
        )}
        {failed && (
          <p role="alert">
            {t(
              "Could not cancel this booking. Contact Cedar Reception.",
              "تعذّر إلغاء هذا الموعد. تواصل مع استقبال سيدر.",
            )}
          </p>
        )}
        <button type="submit">
          {t("Confirm cancellation", "أكّد الإلغاء")}
        </button>
        {onBack && (
          <button type="button" onClick={onBack}>
            {t("Keep booking", "الاحتفاظ بالموعد")}
          </button>
        )}
      </fieldset>
    </form>
  );
}
