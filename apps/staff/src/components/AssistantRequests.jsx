import { useEffect, useState } from "react";
import LoadingStatus from "../../../../shared/ui/LoadingStatus.jsx";
import { REQUEST_REASONS } from "../../../../shared/website-request-contract.mjs";
import { useTask } from "./useTask.js";
import { TEXT } from "./assistantText.js";
import "./bookings.css";

// Rejecting is one confirmation here. Confirming needs patient matching and a
// session check, so it opens the request on its own screen.
export default function AssistantRequests({
  api,
  language,
  onNavigate,
  onError,
  onDone,
}) {
  const t = TEXT[language],
    task = useTask(onError);
  const [requests, setRequests] = useState(null),
    [target, setTarget] = useState(null),
    [reason, setReason] = useState(""),
    [done, setDone] = useState("");

  async function load() {
    const result = await task.run(() =>
      api.websiteRequests({ action: "list", status: "awaiting" }),
    );
    if (result) setRequests(result.requests);
  }
  useEffect(() => {
    load();
  }, []);
  async function reject() {
    const result = await task.run(
      () =>
        api.websiteRequests({
          action: "reject",
          id: target.id,
          revision: target.revision,
          reason,
        }),
      () => {
        setTarget(null);
        load();
      },
    );
    if (!result) return;
    const message = t.rejected(target.reference);
    setDone(message);
    onDone(message);
  }
  const summary = (r) => (
    <>
      <bdi>{r.reference}</bdi> ·{" "}
      <bdi>
        {r.patient?.firstName} {r.patient?.lastName}
      </bdi>{" "}
      · <bdi>{r.selection?.date}</bdi> ·{" "}
      <bdi>{r.selection?.professionalName}</bdi>
    </>
  );
  if (done)
    return (
      <p role="status" className="staff-notice assistant-done">
        <strong>{done}</strong> {t.manual}
      </p>
    );
  return (
    <div className="assistant-task">
      {task.busy && <LoadingStatus label="Checking…" />}
      {task.error && (
        <p className="staff-error" role="alert">
          {task.error}
        </p>
      )}
      {requests && !requests.length && <p role="status">{t.noRequests}</p>}
      <ul className="booking-list">
        {(requests ?? []).map((r) => (
          <li key={r.id}>
            <p>{summary(r)}</p>
            <div className="staff-actions">
              <button
                type="button"
                className="staff-button staff-button-primary"
                onClick={() =>
                  onNavigate({ view: "requests", requestId: r.id })
                }
              >
                {t.openToConfirm}
              </button>
              <button
                type="button"
                className="staff-button staff-button-danger"
                disabled={task.busy}
                onClick={() => {
                  setTarget(r);
                  setReason("");
                }}
              >
                {t.reject}
              </button>
            </div>
          </li>
        ))}
      </ul>
      {target && (
        <div className="staff-action-confirmation">
          <p>{summary(target)}</p>
          <label className="staff-field">
            {t.publicReason}
            <select value={reason} onChange={(e) => setReason(e.target.value)}>
              <option value="" disabled>
                {t.choose}
              </option>
              {Object.entries(REQUEST_REASONS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label[language]}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="staff-button staff-button-primary"
            disabled={task.busy || !reason}
            onClick={reject}
          >
            {t.confirmReject}
          </button>
        </div>
      )}
    </div>
  );
}
