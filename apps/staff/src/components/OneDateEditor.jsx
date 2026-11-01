import { useId, useRef, useState, useEffect } from "react";
import OperationalDialog from "./OperationalDialog.jsx";
import OperationalSessionFields from "./OperationalSessionFields.jsx";
import {
  oneDateReplacement,
  newSession,
  operationalScopeError,
  limitOnlyEdit,
} from "../lib/operations.js";

export default function OneDateEditor({ initial, state, onSave, onClose }) {
  const id = useId(),
    saving = useRef(false),
    alive = useRef(true),
    draftId = useRef(initial.id);
  const [date, setDate] = useState(initial.date),
    [target, setTarget] = useState(
      initial.scopeId ? `scope|${initial.scopeId}` : "",
    );
  const [closed, setClosed] = useState(initial.closed),
    [entries, setEntries] = useState(initial.sessions ?? []);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  let model;
  try {
    model =
      target && date
        ? oneDateReplacement(state, date, target, closed, entries)
        : null;
    if (model && !model.prior) model.record.id = draftId.current;
  } catch {
    model = null;
  }
  const onlyLimit =
    model && limitOnlyEdit("exceptions", model.prior ?? {}, model.record);
  function choose(nextDate, nextTarget) {
    setDate(nextDate);
    setTarget(nextTarget);
    setError("");
    try {
      const next = oneDateReplacement(state, nextDate, nextTarget, false, []);
      setEntries(next.affected.map((s) => ({ ...s })));
      setClosed(false);
    } catch {
      setEntries([]);
    }
  }
  const name = (s) =>
    state.professionals.find((p) => p.id === s.professionalId)?.name ??
    "Service hours";
  const summary = (sessions) =>
    sessions.length
      ? sessions
          .map(
            (s) =>
              `${name(s)}: ${s.startTime}–${s.endTime}${s.status === "cancelled" ? " (cancelled)" : ""}`,
          )
          .join("; ")
      : "No sessions";
  async function submit(event) {
    event.preventDefault();
    if (saving.current || !model) return;
    const failure = operationalScopeError("exceptions", model.record, state);
    if (failure) {
      setError(failure);
      return;
    }
    saving.current = true;
    setBusy(true);
    setError("");
    try {
      await onSave(model.record, model.prior?.revision ?? 0);
      if (alive.current) onClose();
    } catch (failure) {
      if (alive.current) setError(failure.message);
    } finally {
      saving.current = false;
      if (alive.current) setBusy(false);
    }
  }
  return (
    <OperationalDialog titleId={`${id}-title`} busy={busy} onClose={onClose}>
      <h2 id={`${id}-title`}>Change one date</h2>
      <p>Only this date changes. The weekly schedule stays unchanged.</p>
      <p className="staff-help">
        Changing the date or target reloads its current sessions. Review the
        replacement hours before saving.
      </p>
      <p className="staff-help">
        Save a private draft, then review the website update. Publication cannot
        invalidate active bookings: affected bookings must be cancelled
        explicitly first. No patients are moved or cancelled here.
      </p>
      {error && (
        <p className="staff-error" role="alert">
          {error}
        </p>
      )}
      <form onSubmit={submit} className="staff-form">
        <fieldset disabled={busy} className="operational-fields">
          <div className="staff-field">
            <label htmlFor={`${id}-date`}>Date (Asia/Beirut)</label>
            <input
              id={`${id}-date`}
              type="date"
              required
              value={date}
              onChange={(e) => choose(e.target.value, target)}
            />
          </div>
          <div className="staff-field">
            <label htmlFor={`${id}-target`}>What changes?</label>
            <select
              id={`${id}-target`}
              required
              value={target}
              onChange={(e) => choose(date, e.target.value)}
            >
              <option value="" disabled>
                Choose a target
              </option>
              {state.scopes
                .filter((s) => s.active && s.access.edit)
                .map((s) => (
                  <option key={s.id} value={`scope|${s.id}`}>
                    {s.kind === "clinic" ? "Whole clinic" : s.name}
                  </option>
                ))}
              {state.professionals
                .filter((p) => p.canEdit && p.active)
                .map((p) => (
                  <option key={p.id} value={`professional|${p.id}`}>
                    Professional — {p.name}
                  </option>
                ))}
            </select>
          </div>
          {model && (
            <>
              <div className="staff-field">
                <label htmlFor={`${id}-action`}>Change</label>
                <select
                  id={`${id}-action`}
                  value={closed ? "closed" : "hours"}
                  onChange={(e) => setClosed(e.target.value === "closed")}
                >
                  <option value="closed">
                    {model.professional ? "Away" : "Closed"}
                  </option>
                  <option value="hours">Different hours</option>
                </select>
              </div>
              <h3>Current hours / sessions</h3>
              <p>{summary(model.affected)}</p>
              {!closed && (
                <>
                  <h3>Replacement hours / sessions</h3>
                  {entries.map((entry, index) => (
                    <fieldset key={entry.id}>
                      <legend>{name(entry)}</legend>
                      <OperationalSessionFields
                        state={state}
                        value={entry}
                        fixedScope
                        dated
                        fixedProfessional={Boolean(model.professional)}
                        onChange={(next) =>
                          setEntries(
                            entries.map((s, i) => (i === index ? next : s)),
                          )
                        }
                      />
                      <button
                        className="staff-button"
                        type="button"
                        onClick={() =>
                          setEntries(entries.filter((_, i) => i !== index))
                        }
                      >
                        Remove this replacement
                      </button>
                    </fieldset>
                  ))}
                  <button
                    className="staff-button"
                    type="button"
                    onClick={() =>
                      setEntries([
                        ...entries,
                        {
                          ...newSession(
                            model.scope.id,
                            new Date(`${date}T12:00:00Z`).getUTCDay(),
                          ),
                          ...(model.professional
                            ? { professionalId: model.professional.id }
                            : {}),
                        },
                      ])
                    }
                  >
                    Add replacement hours
                  </button>
                </>
              )}
              <section aria-label="Before and after">
                <h3>Review this date</h3>
                <p>
                  <strong>Before:</strong> {summary(model.current)}
                </p>
                <p>
                  <strong>After:</strong>{" "}
                  {summary(model.record.closed ? [] : model.record.sessions)}
                </p>
                {model.professional && (
                  <p>
                    All other professionals and their saved patient limits stay
                    unchanged.
                  </p>
                )}
              </section>
            </>
          )}
        </fieldset>
        <div className="staff-actions">
          <button
            className="staff-button staff-button-primary"
            disabled={busy || !model}
          >
            {onlyLimit ? "Save patient limit" : "Save draft"}
          </button>
          <button
            type="button"
            className="staff-button"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </button>
        </div>
      </form>
    </OperationalDialog>
  );
}
