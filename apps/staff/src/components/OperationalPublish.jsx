import { useEffect, useId, useRef, useState } from "react";
import LoadingStatus from "../../../../shared/ui/LoadingStatus.jsx";
import OperationalDialog from "./OperationalDialog.jsx";
import { centerToday } from "../lib/operations.js";

export default function OperationalPublish({
  state,
  onReview,
  onPublish,
  onClose,
}) {
  const id = useId(),
    submitting = useRef(false);
  const [selected, setSelected] = useState([]),
    [date, setDate] = useState(centerToday()),
    [baseline, setBaseline] = useState(false),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [review, setReview] = useState(null),
    [reviewing, setReviewing] = useState(false);
  const reviewGeneration = useRef(0);
  const reviewer = useRef(onReview);
  reviewer.current = onReview;
  const signature = JSON.stringify([
    selected,
    baseline,
    date,
    state.revision,
    state.head,
  ]);
  useEffect(() => {
    const version = ++reviewGeneration.current;
    setReview(null);
    setConfirmed(false);
    setError("");
    if (!selected.length || (!baseline && !/^\d{4}-\d{2}-\d{2}$/.test(date))) {
      setReviewing(false);
      return;
    }
    setReviewing(true);
    Promise.resolve()
      .then(() =>
        reviewer.current({
          scopeIds: selected,
          effectiveFrom: baseline ? null : date,
          expectedRevision: state.revision,
          expectedHead: state.head,
        }),
      )
      .then((value) => {
        if (version === reviewGeneration.current)
          setReview({ ...value, signature });
      })
      .catch((failure) => {
        if (version === reviewGeneration.current) setError(failure.message);
      })
      .finally(() => {
        if (version === reviewGeneration.current) setReviewing(false);
      });
    return () => {
      reviewGeneration.current++;
    };
  }, [signature]);
  async function submit(event) {
    event.preventDefault();
    if (
      submitting.current ||
      !review ||
      review.signature !== signature ||
      !review.total ||
      review.conflict ||
      reviewing
    )
      return;
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      await onPublish({
        scopeIds: selected,
        expectedRevision: state.revision,
        expectedHead: state.head,
        effectiveFrom: baseline ? null : date,
        confirmed,
      });
      onClose();
    } catch (failure) {
      setError(failure.message);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  return (
    <OperationalDialog titleId={`${id}-title`} busy={busy} onClose={onClose}>
      <h2 id={`${id}-title`}>Review & update website</h2>
      <p>
        This saves an immutable local version and delivery work. A configured
        receiver is updated only after validated acceptance. The website uses
        accepted information only when its operator has explicitly activated the
        Cedar source.
      </p>
      <p className="staff-help">
        Publish all linked clinics together for shared professional changes.
        Unconfirmed gender, inconsistent references or overlaps prevent
        publication. New snapshots take effect on the chosen Beirut date;
        earlier versions remain stored. Blank patient limits may publish and
        remain not configured.
      </p>
      {reviewing && <LoadingStatus label="Loading website changes…" />}
      {review && review.signature === signature && (
        <section aria-label="Website changes" aria-live="polite">
          {!review.total ? (
            <p>No unpublished website changes.</p>
          ) : (
            <>
              <h3>
                {review.total} website change{review.total === 1 ? "" : "s"}
              </h3>
              <ul className="operational-list">
                {review.changes.map((change, index) => (
                  <li
                    key={`${change.type}:${change.id}:${change.field}:${index}`}
                  >
                    <div>
                      <strong>{change.label}</strong>
                      <p>
                        {change.field}: {String(change.before)} →{" "}
                        {String(change.after)}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
              {review.truncated && (
                <p>
                  Showing the first {review.changes.length} changes of{" "}
                  {review.total}. Review smaller clinic/service groups to see
                  all changes.
                </p>
              )}
            </>
          )}
          {review.conflict && (
            <p className="staff-error" role="alert">
              {review.conflict.message}
            </p>
          )}
          {!review.deliveryConfigured && (
            <p className="staff-notice">
              This isolated service is not connected for website delivery.
              Publishing saves a local version only; no website update will be
              claimed.
            </p>
          )}
        </section>
      )}
      {error && (
        <p role="alert" className="staff-error">
          {error}
        </p>
      )}
      <form className="staff-form" onSubmit={submit}>
        <fieldset disabled={busy} className="operational-fields">
          <legend>Clinic/services included in this update</legend>
          {state.scopes
            .filter((s) => s.access.publish)
            .map((s) => (
              <label className="staff-checkbox" key={s.id}>
                <input
                  type="checkbox"
                  checked={selected.includes(s.id)}
                  onChange={(e) =>
                    setSelected(
                      e.target.checked
                        ? [...selected, s.id]
                        : selected.filter((x) => x !== s.id),
                    )
                  }
                />
                {s.name}
              </label>
            ))}
          <div className="staff-field">
            {state.isAdmin && state.head === 0 && (
              <label className="staff-checkbox">
                <input
                  type="checkbox"
                  checked={baseline}
                  onChange={(e) => {
                    setBaseline(e.target.checked);
                    if (e.target.checked)
                      setSelected(
                        state.scopes
                          .filter((s) => s.access.publish)
                          .map((s) => s.id),
                      );
                  }}
                />
                Publish the first undated baseline (all scopes)
              </label>
            )}
            <label htmlFor={`${id}-date`}>Effective from (Asia/Beirut)</label>
            <input
              type="date"
              id={`${id}-date`}
              value={date}
              onChange={(e) => setDate(e.target.value)}
              required={!baseline}
              disabled={baseline}
            />
          </div>
          <label className="staff-checkbox">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              required
            />
            I reviewed these drafts and understand publication, delivery
            acceptance and website source activation are separate steps.
          </label>
        </fieldset>
        <div className="staff-actions">
          <button
            className="staff-button staff-button-primary"
            type="submit"
            disabled={
              busy ||
              reviewing ||
              !review ||
              review.signature !== signature ||
              !review.total ||
              Boolean(review.conflict)
            }
          >
            {busy ? "Updating…" : "Confirm website update"}
          </button>
          <button
            className="staff-button"
            type="button"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
        </div>
      </form>
    </OperationalDialog>
  );
}
