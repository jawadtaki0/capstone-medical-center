import { useState } from "react";
import { PreviewDialog } from "./FormControls.jsx";
import { notificationText, fullName, professionalFor } from "./model.js";
import { previewStore, usePreview } from "./store.js";

export const noticeLabel = {
  pending: "Pending",
  opened: "WhatsApp link opened",
  sent: "Staff marked sent",
  call_required: "Call required",
  call_recorded: "Recorded call outcome",
  superseded: "Superseded",
};
export default function NotificationPreview({ noticeId, actor, onClose }) {
  const state = usePreview(),
    notice = state.notices.find((n) => n.id === noticeId),
    request = state.requests.find((r) => r.id === notice?.requestId);
  const [language, setLanguage] = useState(notice?.language ?? "en"),
    [ack, setAck] = useState(false),
    [error, setError] = useState(""),
    [call, setCall] = useState(false),
    [outcome, setOutcome] = useState(""),
    [phoneType, setPhoneType] = useState("mobile");
  if (!notice || !request) return null;
  const stale =
    notice.version !== request.version || notice.status === "superseded";
  function update(status, result) {
    try {
      previewStore.notice(noticeId, status, actor, result);
      setError("");
    } catch (e) {
      setError(e.message);
    }
  }
  return (
    <PreviewDialog
      title={
        request.source === "phone"
          ? `Phone-booking notice · ${request.bookingReference}`
          : `Manual WhatsApp · ${request.reference}`
      }
      onClose={onClose}
    >
      <div className="request-alert">
        <strong>Preview only — WhatsApp will not open.</strong>
        <p>
          In the implemented flow, Electron main will open a validated wa.me
          link for this notification ID only. It cannot force the sending
          account: the message comes from the WhatsApp account signed in on that
          computer. No sending account or recipient approval is implied here.
        </p>
      </div>
      <div className="request-tracking-top">
        <span className={`request-status notice-${notice.status}`}>
          {noticeLabel[notice.status]}
        </span>
        <span>Notice version {notice.version}</span>
      </div>
      {stale && (
        <div role="alert" className="request-alert is-error">
          This notice is outdated. Do not send it. Open the latest decision
          notice; earlier opened/sent history is retained.
        </div>
      )}
      {error && (
        <p role="alert" className="request-error">
          {error}
        </p>
      )}
      <dl className="request-review-grid">
        <div>
          <dt>Intended recipient · submitted contact, unverified</dt>
          <dd>
            <bdi dir="ltr">{request.patient.phone}</bdi>
          </dd>
        </div>
        <div>
          <dt>Patient</dt>
          <dd>{fullName(request.patient)}</dd>
        </div>
      </dl>
      <div className="request-form-grid">
        <label className="request-field">
          Message language
          <select
            aria-label="Message language"
            value={language}
            disabled={stale}
            onChange={(e) => {
              setLanguage(e.target.value);
              setAck(false);
            }}
          >
            {[
              ["en", "English"],
              ["ar", "العربية"],
            ].map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="request-field">
          Preview number classification
          <select
            aria-label="Preview number classification"
            value={phoneType}
            onChange={(e) => setPhoneType(e.target.value)}
          >
            <option value="mobile">Valid mobile format</option>
            <option value="fixed">Valid fixed-line format</option>
            <option value="unknown">Unknown classification</option>
          </select>
        </label>
      </div>
      {request.source === "phone" && (
        <p className="request-muted">
          Language is selected for this phone-booking notice only. No
          patient-schema or saved-language migration is implied.
        </p>
      )}
      <div className="request-alert">
        <p>
          {phoneType === "mobile"
            ? "A valid mobile format does not prove WhatsApp availability or ownership."
            : "This number is fixed-line or its type is unknown. WhatsApp availability is not verified; use the call alternative where necessary."}
        </p>
      </div>
      <h3>Fixed message preview</h3>
      <pre
        className="request-message"
        dir={language === "ar" ? "rtl" : "ltr"}
        lang={language}
      >
        {notificationText(request, language)
          .split("\n")
          .map((line, index) => (
            <span key={index}>
              {/^\*[^*]+\*$/.test(line) ? (
                <strong>{line.slice(1, -1)}</strong>
              ) : (
                line
              )}
              {"\n"}
            </span>
          ))}
      </pre>
      <div className="request-actions">
        <button
          className="staff-button staff-button-primary"
          type="button"
          disabled={stale}
          onClick={() => update("opened")}
        >
          Simulate WhatsApp link opened
        </button>
        <button
          className="staff-button"
          type="button"
          disabled={stale}
          onClick={() =>
            setError(
              "Simulated external-open failure. Nothing was marked opened or sent. Retry deliberately or call the patient.",
            )
          }
        >
          Simulate opening failure
        </button>
        <button
          className="staff-button"
          type="button"
          disabled={stale}
          onClick={() => {
            update("call_required");
            setCall(true);
          }}
        >
          Call fallback
        </button>
      </div>
      <p className="request-muted">
        Opening the link is not delivery. If opening succeeds but recording
        fails, the result is uncertain: check WhatsApp before opening again.
        Exactly-once manual sending cannot be guaranteed.
      </p>
      <div className="request-note">
        <label className="request-checkbox">
          <input
            type="checkbox"
            checked={ack}
            disabled={stale || notice.status !== "opened"}
            onChange={(e) => setAck(e.target.checked)}
          />
          I manually sent the message (simulated declaration).
        </label>
        <button
          className="staff-button"
          type="button"
          disabled={stale || !ack || notice.status !== "opened"}
          onClick={() => {
            update("sent");
            setAck(false);
          }}
        >
          Mark sent
        </button>
      </div>
      {(call || notice.status === "call_required") && (
        <form
          className="request-note"
          onSubmit={(e) => {
            e.preventDefault();
            if (outcome.trim()) {
              update("call_recorded", outcome.trim());
              setOutcome("");
              setCall(false);
            }
          }}
        >
          <label className="request-field">
            Private call outcome
            <textarea
              value={outcome}
              onChange={(e) => setOutcome(e.target.value)}
              maxLength={240}
              required
              placeholder="Synthetic example: spoke to the patient; attendance window explained."
            />
          </label>
          <button
            className="staff-button"
            disabled={stale || !outcome.trim()}
            type="submit"
          >
            Record call outcome
          </button>
        </form>
      )}
      <h3>Notification history</h3>
      {!notice.history.length ? (
        <p>No manual actions recorded.</p>
      ) : (
        <ol className="request-timeline">
          {notice.history.map((h, i) => (
            <li key={i}>
              <span className="request-timeline-dot" aria-hidden="true" />
              <div>
                <strong>{noticeLabel[h.status]}</strong>
                <p>{h.actor}</p>
                <time dir="ltr">{new Date(h.at).toLocaleString("en-GB")}</time>
                {h.outcome && <p>{h.outcome}</p>}
              </div>
            </li>
          ))}
        </ol>
      )}
    </PreviewDialog>
  );
}
