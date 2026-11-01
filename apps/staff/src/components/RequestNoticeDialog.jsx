import { useEffect, useRef, useState } from "react";
import PreviewDialog from "./WebsiteRequestDialog.jsx";
import { websiteNoticeLocationText } from "../../../../shared/website-notice.mjs";
import "../website-requests.css";
import LoadingStatus from "../../../../shared/ui/LoadingStatus.jsx";
const noticeNames = {
  pending: "Message not sent",
  opened: "WhatsApp link opened",
  sent: "Staff marked sent",
  call_required: "Call required",
  call_recorded: "Recorded call outcome",
  superseded: "Superseded",
};

export function BookingNoticeButton({ api, bookingId, onError, onChanged }) {
  const [noticeId, setNoticeId] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const alive = useRef(true),
    pending = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  async function open() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await api.websiteRequests({
        action: "bookingNoticeLookup",
        bookingId,
      });
      if (alive.current) {
        if (result.noticeId) setNoticeId(result.noticeId);
        else
          setError(
            result.message ??
              "No current message is available for this booking. Check Messages to send for its retained history.",
          );
      }
    } catch (e) {
      if (alive.current) {
        setError(e.message);
        onError?.(e);
      }
    } finally {
      pending.current = false;
      if (alive.current) setBusy(false);
    }
  }
  return (
    <>
      <button
        type="button"
        className="staff-button"
        disabled={busy}
        onClick={open}
      >
        {busy ? "Loading message…" : "Send via WhatsApp"}
      </button>
      {error && (
        <p role="alert" className="staff-error">
          {error}
        </p>
      )}
      {noticeId && (
        <RequestNoticeDialog
          key={noticeId}
          api={api}
          noticeId={noticeId}
          onError={onError}
          onClose={() => setNoticeId(null)}
          onChanged={onChanged}
        />
      )}
    </>
  );
}

export default function RequestNoticeDialog({
  api,
  noticeId,
  onClose,
  onError,
  onChanged,
}) {
  const [notice, setNotice] = useState(null),
    [language, setLanguage] = useState("en"),
    [ack, setAck] = useState(false),
    [sentAck, setSentAck] = useState(false),
    [reason, setReason] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [feedback, setFeedback] = useState("");
  const generation = useRef(0),
    pending = useRef(false),
    alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      generation.current++;
    };
  }, []);
  async function run(action, clearError = true) {
    if (pending.current) return null;
    pending.current = true;
    const g = generation.current;
    setBusy(true);
    if (clearError) setError("");
    try {
      const r = await action();
      return alive.current && generation.current === g ? r : null;
    } catch (e) {
      if (alive.current && generation.current === g) {
        setError(e.message);
        onError?.(e);
      }
      return null;
    } finally {
      pending.current = false;
      if (alive.current && generation.current === g) setBusy(false);
    }
  }
  async function load(lang = language, clearError = true) {
    const out = await run(
      () =>
        api.websiteRequests({
          action: "notification",
          noticeId,
          noticeAction: "preview",
          language: lang,
        }),
      clearError,
    );
    if (out) {
      setNotice(out);
      setAck(false);
      setSentAck(false);
    }
  }
  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => {
      clearTimeout(timer);
      generation.current++;
    };
  }, [noticeId]);
  function close() {
    if (pending.current) return;
    generation.current++;
    setNotice(null);
    setReason("");
    onClose();
  }
  async function noticeAction(action, body = {}) {
    const r = await run(() =>
      api.websiteRequests({
        action: "notification",
        noticeId,
        noticeAction: action,
        language,
        ...body,
      }),
    );
    if (r) {
      onChanged?.();
      await load();
    }
  }
  async function openWhatsApp() {
    const r = await run(async () => {
      await api.websiteRequests({
        action: "notification",
        noticeAction: "configure",
        noticeId,
        language,
        contactAcknowledged: ack,
      });
      return api.openRequestWhatsApp({ noticeId });
    });
    if (r) {
      setFeedback(
        r.warning ??
          "WhatsApp link opened. This is not delivery; mark sent only after manually sending.",
      );
      onChanged?.();
    }
    await load(language, false);
  }
  if (!notice)
    return (
      <PreviewDialog title="Manual WhatsApp" onClose={close}>
        {busy ? (
          <LoadingStatus label="Loading message…" />
        ) : (
          <p role="status">Message unavailable. No message was sent.</p>
        )}
        {error && (
          <p role="alert" className="request-error">
            {error}
          </p>
        )}
        <button className="staff-button" disabled={busy} onClick={() => load()}>
          Retry message
        </button>
      </PreviewDialog>
    );
  return (
    <>
      {notice && (
        <PreviewDialog title="Manual WhatsApp" onClose={close}>
          <fieldset disabled={busy} className="request-detail-fields">
            <div className="request-alert">
              {websiteNoticeLocationText(notice.localReviewOnly)}
            </div>
            <label className="request-field">
              Message language
              <select
                aria-label="Message language"
                value={language}
                onChange={async (e) => {
                  setLanguage(e.target.value);
                  void load(e.target.value);
                }}
              >
                <option value="en">English</option>
                <option value="ar">العربية</option>
              </select>
            </label>
            {notice.openingUncertain && (
              <div className="request-alert">
                <p>
                  An opening attempt may have occurred, but its outcome is not
                  recorded. Check WhatsApp before trying again. Nothing is
                  marked sent.
                </p>
                <button
                  className="staff-button"
                  disabled={busy || notice.stale}
                  onClick={() => noticeAction("resolve_uncertain")}
                >
                  I checked WhatsApp — allow another opening
                </button>
              </div>
            )}
            {notice.phoneWarning && (
              <p className="request-alert" role="status">
                {notice.phoneWarning}
              </p>
            )}
            <pre
              className="request-message"
              dir={language === "ar" ? "rtl" : "ltr"}
            >
              {notice.message.split("\n").map((line, i) => (
                <span key={i}>
                  {/^\*[^*]+\*$/.test(line) ? (
                    <strong>{line.slice(1, -1)}</strong>
                  ) : (
                    line
                  )}
                  {"\n"}
                </span>
              ))}
            </pre>
            <p>
              {noticeNames[notice.notice.state]}
              {notice.stale ? " — outdated notice; history only" : ""}
            </p>
            <label className="request-checkbox">
              <input
                type="checkbox"
                checked={ack}
                onChange={(e) => setAck(e.target.checked)}
              />
              I checked the original submitted phone, including any difference
              from the registry. This phone remains unverified.
            </label>
            <label className="request-checkbox">
              <input
                type="checkbox"
                checked={sentAck}
                disabled={notice.stale || notice.notice.state !== "opened"}
                onChange={(e) => setSentAck(e.target.checked)}
              />
              I manually sent this message in WhatsApp.
            </label>
            <div className="staff-actions">
              <button
                className="staff-button staff-button-primary"
                disabled={
                  busy ||
                  notice.stale ||
                  notice.openingUncertain ||
                  !ack ||
                  notice.notice.state === "sent"
                }
                onClick={openWhatsApp}
              >
                Send via WhatsApp
              </button>
              <button
                className="staff-button"
                disabled={
                  busy ||
                  notice.stale ||
                  notice.notice.state !== "opened" ||
                  !sentAck
                }
                onClick={() => noticeAction("sent")}
              >
                I manually sent it — mark sent
              </button>
              <button
                className="staff-button"
                disabled={busy || notice.stale}
                onClick={() => noticeAction("call_required")}
              >
                Call fallback
              </button>
            </div>
            <label className="request-field">
              Private call outcome
              <input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={240}
              />
            </label>
            <button
              className="staff-button"
              disabled={busy || notice.stale || !reason.trim()}
              onClick={() => noticeAction("call_recorded", { outcome: reason })}
            >
              Record call outcome
            </button>
            <h3>Notification history</h3>
            <ul>
              {notice.notice.history.map((h, i) => (
                <li key={i}>
                  {h.action} · {new Date(h.at).toLocaleString()}
                </li>
              ))}
            </ul>
            {feedback && <p role="status">{feedback}</p>}
            {error && (
              <p role="alert" className="request-error">
                {error}
              </p>
            )}
          </fieldset>
        </PreviewDialog>
      )}
    </>
  );
}
