import { useId } from "react";
import { WEEKDAYS } from "../lib/operations.js";
import {
  parsePatientLimit,
  validPatientLimit,
} from "../../../../shared/session-capacity.mjs";

export default function OperationalSessionFields({
  value,
  onChange,
  state,
  fixedScope = false,
  dated = false,
}) {
  const id = useId();
  const set = (key, next) => onChange({ ...value, [key]: next });
  const scope = state.scopes.find((s) => s.id === value.scopeId);
  const professionals = state.professionals.filter((p) =>
    p.scopeIds.includes(value.scopeId),
  );
  const field = (key, label, type = "text", extra = {}) => (
    <div className="staff-field">
      <label htmlFor={`${id}-${key}`}>{label}</label>
      <input
        id={`${id}-${key}`}
        type={type}
        value={value[key] ?? ""}
        onChange={(e) => set(key, e.target.value)}
        {...extra}
      />
    </div>
  );
  return (
    <div className="staff-form-grid">
      {!fixedScope && (
        <div className="staff-field">
          <label htmlFor={`${id}-scope`}>Clinic/service</label>
          <select
            id={`${id}-scope`}
            value={value.scopeId}
            onChange={(e) =>
              onChange({
                ...value,
                scopeId: e.target.value,
                professionalId: null,
                capacity:
                  state.scopes.find((s) => s.id === e.target.value)?.kind ===
                  "service"
                    ? null
                    : value.capacity,
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
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
          </select>
        </div>
      )}
      {!dated && (
        <div className="staff-field">
          <label htmlFor={`${id}-day`}>Recurring weekday</label>
          <select
            id={`${id}-day`}
            value={value.weekday}
            onChange={(e) => set("weekday", Number(e.target.value))}
          >
            {WEEKDAYS.map((name, day) => (
              <option value={day} key={name}>
                {name}
              </option>
            ))}
          </select>
        </div>
      )}
      {scope?.kind === "clinic" && (
        <div className="staff-field">
          <label htmlFor={`${id}-professional`}>Professional</label>
          <select
            id={`${id}-professional`}
            value={value.professionalId ?? ""}
            onChange={(e) => set("professionalId", e.target.value || null)}
            required
          >
            <option value="">Choose professional</option>
            {professionals.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.active ? "" : " — inactive"}
              </option>
            ))}
          </select>
        </div>
      )}
      {field("startTime", "Session start", "time", { required: true })}
      {field("endTime", "Session end", "time", { required: true })}
      {scope?.kind === "clinic" && (
        <div className="staff-field">
          <label htmlFor={`${id}-capacity`}>Patient limit</label>
          <input
            id={`${id}-capacity`}
            type="text"
            inputMode="numeric"
            value={value.capacity ?? ""}
            aria-describedby={`${id}-capacity-help`}
            aria-invalid={!validPatientLimit(value.capacity)}
            onChange={(e) => {
              try {
                set("capacity", parsePatientLimit(e.target.value));
              } catch {
                set("capacity", e.target.value);
              }
            }}
          />
          <p className="staff-help" id={`${id}-capacity-help`}>
            Optional positive whole number. Blank means not configured, not
            unlimited. A saved limit takes effect immediately for matching
            published sessions; confirmation requires a configured limit. It
            cannot be unset or reduced below confirmed bookings. Hours and
            specialty edits preserve the saved limit. This does not create
            appointment time slots.
          </p>
          {!validPatientLimit(value.capacity) && (
            <p className="staff-error" role="alert">
              Enter a positive whole patient limit, or leave it blank.
            </p>
          )}
        </div>
      )}
      <div className="staff-field">
        <label htmlFor={`${id}-status`}>Session status</label>
        <select
          id={`${id}-status`}
          value={value.status}
          onChange={(e) => set("status", e.target.value)}
        >
          <option value="active">Active</option>
          <option value="cancelled">Cancelled</option>
        </select>
      </div>
      {scope?.kind === "clinic" && (
        <label className="staff-checkbox">
          <input
            type="checkbox"
            checked={value.appointmentRequired}
            onChange={(e) => set("appointmentRequired", e.target.checked)}
          />
          Appointment required (no walk-in)
        </label>
      )}
    </div>
  );
}
