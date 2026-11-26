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

const unavailable = {
  cutoff: [
    "The online cancellation deadline has passed. Contact Cedar Reception for help.",
    "انتهت مهلة الإلغاء عبر الإنترنت. تواصل مع استقبال سيدر للمساعدة.",
  ],
  past: [
    "This appointment time has passed. Contact Cedar Reception for help.",
    "مرّ وقت هذا الموعد. تواصل مع استقبال سيدر للمساعدة.",
  ],
  status: [
    "This booking’s status does not allow online cancellation. Contact Cedar Reception for help.",
    "لا تسمح حالة هذا الموعد بإلغائه عبر الإنترنت. تواصل مع استقبال سيدر للمساعدة.",
  ],
};

export function cancellationUnavailable(reason, ar) {
  return (unavailable[reason] ?? unavailable.status)[ar ? 1 : 0];
}

export default function CancellationForm({ ar, submit, onBack, inDialog }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [other, setOther] = useState(false);
  const [noteLength, setNoteLength] = useState(0);
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
      <fieldset disabled={busy || undefined}>
        <legend className={inDialog ? "cedar-assistant-hidden" : undefined}>
          {t("Confirm cancellation", "تأكيد الإلغاء")}
        </legend>
        <p>
          {t(
            "The booking cannot be restored. Reasons are optional.",
            "لا يمكن استعادة الموعد. ذكر الأسباب اختياري.",
          )}
        </p>
        <div className={inDialog ? "cedar-cancellation-reasons" : undefined}>
        {reasons.map(([code, en, arabic]) => (
          <label key={code}>
            <input
              type="checkbox"
              name="reasons"
              value={code}
              onChange={
                code === "other" ? (e) => {
                  setOther(e.target.checked);
                  if (!e.target.checked) setNoteLength(0);
                } : undefined
              }
            />
            {t(en, arabic)}
          </label>
        ))}
        </div>
        {other && (
          <label className={inDialog ? "cedar-cancellation-note" : undefined}>
            {t("Other reason", "سبب آخر")}{" "}
            <textarea name="note" maxLength={200} onChange={inDialog ? (event) => setNoteLength(event.target.value.length) : undefined} />
            {inDialog && <span dir="ltr">{noteLength} / 200</span>}
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
        <div className={inDialog ? "cedar-cancellation-actions" : undefined}>
        {!inDialog && <button type="submit">{t("Confirm cancellation", "أكّد الإلغاء")}</button>}
        {onBack && (
          <button type="button" onClick={onBack} autoFocus={inDialog} className={inDialog ? "button cedar-cancellation-keep" : undefined}>
            {t("Keep booking", "الاحتفاظ بالموعد")}
          </button>
        )}
        {inDialog && <button type="submit" className="button cedar-cancellation-confirm">{t("Confirm cancellation", "أكّد الإلغاء")}</button>}
        </div>
      </fieldset>
    </form>
  );
}
