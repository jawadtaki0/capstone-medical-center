import { useEffect, useId, useRef, useState } from "react";
import OperationalSessionFields from "./OperationalSessionFields.jsx";
import OperationalDialog from "./OperationalDialog.jsx";
import {
  cleanOperationalRecord,
  centerToday,
  newSession,
  operationalScopeError,
  WEEKDAYS,
} from "../lib/operations.js";

export default function OperationalEditor({
  type,
  initial,
  state,
  onSave,
  onClose,
}) {
  const id = useId(),
    live = useRef(true),
    submitting = useRef(false);
  const [value, setValue] = useState(() =>
    cleanOperationalRecord(type, initial),
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const set = (key, next) => setValue((old) => ({ ...old, [key]: next }));
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  async function submit(event) {
    event.preventDefault();
    if (submitting.current) return;
    const scopeError = operationalScopeError(type, value, state);
    if (scopeError) {
      setError(scopeError);
      return;
    }
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      await onSave(cleanOperationalRecord(type, value), initial.revision ?? 0);
      if (live.current) onClose();
    } catch (failure) {
      if (live.current) setError(failure.message);
    } finally {
      submitting.current = false;
      if (live.current) setBusy(false);
    }
  }
  const field = (key, label, inputType = "text", extra = {}) => (
    <div className="staff-field">
      <label htmlFor={`${id}-${key}`}>{label}</label>
      <input
        id={`${id}-${key}`}
        type={inputType}
        value={value[key] ?? ""}
        onChange={(e) => set(key, e.target.value)}
        {...extra}
      />
    </div>
  );
  const select = (key, label, choices, disabled = false) => (
    <div className="staff-field">
      <label htmlFor={`${id}-${key}`}>{label}</label>
      <select
        id={`${id}-${key}`}
        value={value[key]}
        disabled={disabled}
        onChange={(e) => {
          const next = { ...value, [key]: e.target.value };
          if (type === "professionals" && key === "kind" && !initial.revision)
            next.id = `${next.kind}:${initial.id.split(":").slice(1).join(":")}`;
          setValue(next);
        }}
      >
        {choices.map(([code, text]) => (
          <option key={code} value={code}>
            {text}
          </option>
        ))}
      </select>
    </div>
  );
  const active = (
    <label className="staff-checkbox">
      <input
        type="checkbox"
        checked={value.active}
        onChange={(e) => set("active", e.target.checked)}
      />
      Active (deactivate; never delete history)
    </label>
  );
  const titles = {
    scopes: "Clinic/service registry",
    professionals: "Professional profile draft",
    sessions: "Recurring session draft",
    exceptions: "One-date scope exception",
    hours: "Center opening hours draft",
  };
  const dayNumber = (date) => new Date(`${date}T12:00:00Z`).getUTCDay();
  return (
    <OperationalDialog titleId={`${id}-title`} busy={busy} onClose={onClose}>
      <h2 id={`${id}-title`}>{titles[type]}</h2>
      <p className="staff-help">
        Saved as a staff-only draft. Website information changes only after
        authorized publication, receiver acceptance and operator source
        activation.
      </p>
      {error && (
        <p className="staff-error" role="alert">
          {error}
        </p>
      )}
      <form className="staff-form" onSubmit={submit}>
        <fieldset disabled={busy} className="operational-fields">
          {type === "scopes" && (
            <>
              {field("name", "Clinic/service name", "text", {
                required: true,
                maxLength: 160,
              })}
              {select(
                "kind",
                "Registry type",
                [
                  ["clinic", "Clinic"],
                  ["service", "Separate public service"],
                ],
                Boolean(initial.revision),
              )}
              {active}
              <p className="staff-help">
                A service name does not grant responsibility. Admin assigns it
                explicitly to staff below.
              </p>
            </>
          )}
          {type === "professionals" && (
            <>
              {select(
                "kind",
                "Professional kind",
                [
                  ["doctor", "Doctor"],
                  ["specialist", "Specialist (not a doctor)"],
                ],
                Boolean(initial.revision),
              )}
              {field("name", "Professional name and actual title", "text", {
                required: true,
                maxLength: 160,
              })}
              {field("specialty", "Specialty", "text", {
                required: true,
                maxLength: 160,
              })}
              {select("gender", "Gender", [
                ["neutral", "Unconfirmed — draft only"],
                ["male", "Male — confirmed"],
                ["female", "Female — confirmed"],
              ])}
              <fieldset>
                <legend>Assigned clinics</legend>
                {state.scopes
                  .filter((s) => s.kind === "clinic" && s.access.edit)
                  .map((s) => (
                    <label className="staff-checkbox" key={s.id}>
                      <input
                        type="checkbox"
                        checked={value.scopeIds.includes(s.id)}
                        onChange={(e) =>
                          set(
                            "scopeIds",
                            e.target.checked
                              ? [...value.scopeIds, s.id]
                              : value.scopeIds.filter((x) => x !== s.id),
                          )
                        }
                      />
                      {s.name}
                    </label>
                  ))}
              </fieldset>
              {active}
              <p className="staff-help">
                Before publishing deactivation, explicitly cancel/revise active
                sessions. Historical versions remain stored. Future appointment
                review is not implemented.
              </p>
            </>
          )}
          {type === "sessions" && (
            <OperationalSessionFields
              value={value}
              onChange={setValue}
              state={state}
            />
          )}
          {type === "hours" && (
            <>
              <div className="staff-field">
                <label htmlFor={`${id}-hours-mode`}>Applies to</label>
                <select
                  id={`${id}-hours-mode`}
                  disabled={Boolean(initial.revision)}
                  value={value.id.length === 1 ? "weekly" : "date"}
                  onChange={(e) =>
                    set("id", e.target.value === "weekly" ? "1" : centerToday())
                  }
                >
                  <option value="weekly">Recurring weekday</option>
                  <option value="date">Specific date / center holiday</option>
                </select>
              </div>
              {value.id.length === 1 ? (
                <div className="staff-field">
                  <label htmlFor={`${id}-hours-day`}>Weekday</label>
                  <select
                    id={`${id}-hours-day`}
                    disabled={Boolean(initial.revision)}
                    value={value.id}
                    onChange={(e) => set("id", e.target.value)}
                  >
                    {WEEKDAYS.map((day, n) => (
                      <option value={n} key={day}>
                        {day}
                      </option>
                    ))}
                  </select>
                </div>
              ) : (
                field("id", "Center-local date", "date", {
                  required: true,
                  readOnly: Boolean(initial.revision),
                })
              )}
              <label className="staff-checkbox">
                <input
                  type="checkbox"
                  checked={value.closed}
                  onChange={(e) => set("closed", e.target.checked)}
                />
                Center closed
              </label>
              {!value.closed && (
                <div className="staff-form-grid">
                  {field("startTime", "Doors open", "time", { required: true })}
                  {field("endTime", "Doors close", "time", { required: true })}
                </div>
              )}
              <p className="staff-help">
                A dated closure overrides that date only. No automatic holiday
                calendar or overnight hours.
              </p>
            </>
          )}
          {type === "exceptions" && (
            <>
              <div className="staff-field">
                <label htmlFor={`${id}-scope`}>Assigned clinic/service</label>
                <select
                  id={`${id}-scope`}
                  value={value.scopeId}
                  onChange={(e) =>
                    setValue({
                      ...value,
                      scopeId: e.target.value,
                      sessions: [],
                    })
                  }
                  required
                >
                  <option value="" disabled>
                    Choose assigned scope
                  </option>
                  {state.scopes
                    .filter((s) => s.access.edit && s.active)
                    .map((s) => (
                      <option value={s.id} key={s.id}>
                        {s.name}
                      </option>
                    ))}
                </select>
              </div>
              <div className="staff-field">
                <label htmlFor={`${id}-date`}>
                  Specific date (Asia/Beirut)
                </label>
                <input
                  type="date"
                  id={`${id}-date`}
                  value={value.date}
                  onChange={(e) =>
                    setValue({
                      ...value,
                      date: e.target.value,
                      sessions: value.sessions.map((s) => ({
                        ...s,
                        weekday: dayNumber(e.target.value),
                      })),
                    })
                  }
                  required
                />
              </div>
              <label className="staff-checkbox">
                <input
                  type="checkbox"
                  checked={value.closed}
                  onChange={(e) => set("closed", e.target.checked)}
                />
                No sessions in this scope on this date (leave/closure)
              </label>
              <p className="staff-help">
                This replaces only this scope's sessions for one date. Other
                clinics/services are preserved. Changing scope clears the
                replacement list.
              </p>
              {!value.closed && (
                <>
                  {value.sessions.map((entry, index) => (
                    <fieldset key={entry.id}>
                      <legend>Replacement session {index + 1}</legend>
                      <OperationalSessionFields
                        state={state}
                        value={entry}
                        fixedScope
                        dated
                        onChange={(next) =>
                          set(
                            "sessions",
                            value.sessions.map((s, i) =>
                              i === index ? next : s,
                            ),
                          )
                        }
                      />
                      <button
                        type="button"
                        className="staff-button"
                        onClick={() =>
                          set(
                            "sessions",
                            value.sessions.filter((_, i) => i !== index),
                          )
                        }
                      >
                        Remove this draft replacement
                      </button>
                    </fieldset>
                  ))}
                  <div className="staff-actions">
                    <button
                      className="staff-button"
                      type="button"
                      onClick={() =>
                        set("sessions", [
                          ...value.sessions,
                          newSession(value.scopeId, dayNumber(value.date)),
                        ])
                      }
                    >
                      Add replacement session
                    </button>
                    <button
                      className="staff-button"
                      type="button"
                      onClick={() =>
                        set(
                          "sessions",
                          state.sessions
                            .filter(
                              (s) =>
                                s.scopeId === value.scopeId &&
                                s.weekday === dayNumber(value.date),
                            )
                            .map((s) => cleanOperationalRecord("sessions", s)),
                        )
                      }
                    >
                      Use regular sessions
                    </button>
                  </div>
                </>
              )}
            </>
          )}
        </fieldset>
        <div className="staff-actions">
          <button
            className="staff-button staff-button-primary"
            type="submit"
            disabled={busy}
          >
            Save draft
          </button>
          <button
            className="staff-button"
            type="button"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </button>
        </div>
        {busy && <p role="status">Saving draft…</p>}
      </form>
    </OperationalDialog>
  );
}
