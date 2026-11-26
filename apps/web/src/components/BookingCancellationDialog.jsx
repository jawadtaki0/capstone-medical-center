import { useEffect, useId, useRef, useState } from "react";
import CancellationForm from "./CancellationForm.jsx";

export function BookingSummary({ record, profile, ar, confirmation = false }) {
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
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 5.1c2.4-2.3 6.5-2.6 8.1 1 1.5 3.1-.4 5.7-1.5 8.3-1 2.4-1 6.1-2.7 6.1-1.5 0-1.5-4.8-3.9-4.8s-2.4 4.8-3.9 4.8c-1.7 0-1.7-3.7-2.7-6.1C4.3 11.8 2.4 9.2 3.9 6.1c1.6-3.6 5.7-3.3 8.1-1Zm0 0c.8.7 1.5 1.2 2.4 1.3" />
          </svg>
        </span>
      )}
      <div>
        <strong dir="auto">{record.professional}</strong>
        {record.specialty && <div dir="auto">{record.specialty}</div>}
        <div>
          <bdi>{day}</bdi>
          {" · "}
          <bdi dir="ltr">
            {record.startTime}–{record.endTime}
          </bdi>
          {confirmation && (ar ? " · بتوقيت بيروت" : " · Beirut time")}
        </div>
        {confirmation && <div dir="auto">{profile}</div>}
      </div>
    </div>
  );
}

export default function BookingCancellationDialog({
  record,
  profile,
  ar,
  submit,
  onClose,
  standalone = false,
}) {
  const dialog = useRef(null);
  const title = useId();
  const cancelled = useRef(false);
  const [closing, setClosing] = useState(false);
  useEffect(() => {
    const modal = dialog.current;
    modal.showModal();
    modal.querySelector(".cedar-cancellation-keep").focus();
  }, []);
  const finish = () => {
    dialog.current.close();
    onClose(cancelled.current);
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
      data-standalone={standalone || undefined}
      dir={ar ? "rtl" : "ltr"}
      aria-labelledby={title}
      onCancel={(event) => {
        event.preventDefault();
        if (!dialog.current.querySelector("fieldset")?.disabled) dismiss();
      }}
      onAnimationEnd={(event) => {
        if (event.target !== event.currentTarget || !closing) return;
        finish();
      }}
    >
      <h3 id={title}>{ar ? "تأكيد الإلغاء" : "Confirm cancellation"}</h3>
      <div className="cedar-cancellation-content">
        <BookingSummary
          record={record}
          profile={profile}
          ar={ar}
          confirmation
        />
        <CancellationForm
          ar={ar}
          inDialog
          onBack={dismiss}
          submit={async (confirmation) => {
            await submit(confirmation);
            cancelled.current = true;
            if (dialog.current) dismiss();
          }}
        />
      </div>
    </dialog>
  );
}
