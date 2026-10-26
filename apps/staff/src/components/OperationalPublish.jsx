import { useId, useRef, useState } from "react";
import OperationalDialog from "./OperationalDialog.jsx";
import { centerToday } from "../lib/operations.js";

export default function OperationalPublish({ state, onPublish, onClose }) {
  const id = useId(),
    submitting = useRef(false);
  const [selected, setSelected] = useState([]),
    [date, setDate] = useState(centerToday()),
    [baseline, setBaseline] = useState(false),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function submit(event) {
    event.preventDefault();
    if (submitting.current) return;
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
      <h2 id={`${id}-title`}>Review and publish local snapshot</h2>
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
      {error && (
        <p role="alert" className="staff-error">
          {error}
        </p>
      )}
      <form className="staff-form" onSubmit={submit}>
        <fieldset disabled={busy} className="operational-fields">
          <legend>Authorized scopes to publish</legend>
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
            disabled={busy || !selected.length}
          >
            Publish selected drafts
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
