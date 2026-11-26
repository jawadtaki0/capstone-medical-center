import { useEffect, useState } from "react";
import LoadingStatus from "../../../../shared/ui/LoadingStatus.jsx";
import {
  matchProfessionals,
  readLimit,
  limitChange,
  absenceChange,
} from "../lib/assistantSchedule.js";
import { useTask } from "./useTask.js";
import { TEXT } from "./assistantText.js";
import "./bookings.css";

// Clinic schedule changes through the same endpoints as the Schedules screen.
export default function AssistantSchedule({
  api,
  type,
  language,
  prefill,
  question,
  today,
  onError,
  onDone,
}) {
  const t = TEXT[language],
    task = useTask(onError),
    absent = type === "absence",
    asked = readLimit(question);
  const [state, setState] = useState(null),
    [professional, setProfessional] = useState(""),
    [session, setSession] = useState(""),
    [limit, setLimit] = useState(asked.to ? String(asked.to) : ""),
    [dates, setDates] = useState(prefill.dates ?? []),
    [date, setDate] = useState(""),
    [preview, setPreview] = useState(null),
    [saved, setSaved] = useState([]),
    [done, setDone] = useState("");

  const editable = (s) =>
    s?.professionals.filter((p) => p.canEdit && p.active) ?? [];
  async function load() {
    const result = await task.run(() => api.operationalState());
    if (!result) return;
    setState(result);
    const named = matchProfessionals(question, editable(result));
    // Two matching names are a choice for the person, not for the assistant.
    if (named.length === 1) setProfessional(named[0].id);
  }
  useEffect(() => {
    load();
  }, []);

  // Shows what each date would change, including bookings that stay.
  useEffect(() => {
    setPreview(null);
    if (!absent || !state || !professional || !dates.length) return;
    task
      .run(async () => {
        const rows = [];
        for (const day of dates) {
          const change = absenceChange(state, day, professional);
          const { scopeId } = change.request.record;
          const bookings = change.affected.length
            ? (await api.listBookings({ date: day, scopeId })).bookings.filter(
                (b) =>
                  b.status === "confirmed" && b.professionalId === professional,
              )
            : [];
          rows.push({ date: day, sessions: change.affected, bookings });
        }
        return rows;
      })
      .then((rows) => rows && setPreview(rows));
  }, [state, professional, dates]);

  const person = editable(state).find((p) => p.id === professional);
  const sessions = (state?.sessions ?? []).filter(
    (s) => s.professionalId === professional && s.status === "active",
  );
  const chosen =
    sessions.find((s) => s.id === session) ??
    (sessions.length === 1 ? sessions[0] : null);
  const label = (s) =>
    `${t.days[s.weekday]} ${s.startTime}–${s.endTime} · ${t.nowLimit(s.capacity)}`;
  const capacity = Number(limit);
  const validLimit =
    Number.isSafeInteger(capacity) &&
    capacity > 0 &&
    capacity !== chosen?.capacity;

  async function saveLimit() {
    const result = await task.run(
      () => api.saveOperationalRecord(limitChange(chosen, capacity)),
      () => load(),
    );
    if (!result) return;
    const message = t.limitDone(person.name, capacity);
    setDone(message);
    onDone(message);
  }
  async function saveAbsence() {
    const finished = [...saved];
    const result = await task.run(
      async () => {
        let current = state;
        for (const row of preview) {
          if (finished.includes(row.date) || !row.sessions.length) continue;
          const { request } = absenceChange(current, row.date, professional);
          await api.saveOperationalRecord(request);
          finished.push(row.date);
          current = await api.operationalState();
        }
        return finished;
      },
      () => {
        setSaved(finished);
        load();
      },
    );
    if (!result) return;
    const message = t.absenceDone(person.name, result.join(", "));
    setDone(message);
    onDone(message);
  }

  if (done)
    return (
      <div role="status" className="staff-notice assistant-done">
        <p>
          <strong>{done}</strong>
        </p>
      </div>
    );
  const affected = (preview ?? []).reduce((n, r) => n + r.bookings.length, 0);
  const pending = (preview ?? []).filter(
    (r) => r.sessions.length && !saved.includes(r.date),
  );
  return (
    <div className="assistant-task">
      {state && (
        <label className="staff-field">
          {t.doctor}
          <select
            value={professional}
            disabled={task.busy}
            onChange={(e) => {
              setProfessional(e.target.value);
              setSession("");
              setSaved([]);
            }}
          >
            <option value="" disabled>
              {t.choose}
            </option>
            {editable(state).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {!absent && person && (
        <>
          <label className="staff-field">
            {t.weekly}
            <select
              value={chosen?.id ?? ""}
              disabled={task.busy}
              onChange={(e) => setSession(e.target.value)}
            >
              <option value="" disabled>
                {t.choose}
              </option>
              {sessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {label(s)}
                </option>
              ))}
            </select>
          </label>
          <label className="staff-field">
            {t.newLimit}
            <input
              type="number"
              min="1"
              step="1"
              value={limit}
              disabled={task.busy}
              onChange={(e) => setLimit(e.target.value)}
            />
          </label>
        </>
      )}
      {absent && state && (
        <>
          <ul className="booking-list">
            {dates.map((day) => (
              <li key={day} className="assistant-chosen">
                <p>
                  <bdi>{day}</bdi>
                </p>
                <button
                  type="button"
                  className="staff-button"
                  disabled={task.busy || saved.includes(day)}
                  onClick={() => setDates(dates.filter((d) => d !== day))}
                >
                  {t.removeDate}
                </button>
              </li>
            ))}
          </ul>
          <div className="staff-form-grid booking-fields">
            <label className="staff-field">
              {t.date}
              <input
                type="date"
                min={today}
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </label>
            <button
              type="button"
              className="staff-button"
              disabled={task.busy || !date || date < today}
              onClick={() => {
                setDates([...new Set([...dates, date])].sort());
                setDate("");
              }}
            >
              {t.addDate}
            </button>
          </div>
        </>
      )}
      {task.busy && <LoadingStatus label="Checking…" />}
      {task.error && (
        <p className="staff-error" role="alert">
          {task.error}
        </p>
      )}
      {saved.length > 0 && (
        <p role="status">{t.absencePartial(saved.join(", "))}</p>
      )}
      {!absent && chosen && validLimit && (
        <div className="staff-action-confirmation">
          <p>
            <bdi>{person.name}</bdi> · <bdi>{label(chosen)}</bdi> →{" "}
            <strong>{capacity}</strong>
          </p>
          {asked.from !== undefined && asked.from !== chosen.capacity && (
            <p role="alert">{t.notFrom(asked.from, chosen.capacity ?? "—")}</p>
          )}
          <p>{t.limitScope}</p>
          <button
            type="button"
            className="staff-button staff-button-primary"
            disabled={task.busy}
            onClick={saveLimit}
          >
            {t.confirmLimit}
          </button>
        </div>
      )}
      {absent && preview && (
        <div className="staff-action-confirmation">
          <p>
            <strong>
              <bdi>{person.name}</bdi>
            </strong>
          </p>
          {preview.map((row) => (
            <div key={row.date}>
              <p>
                <bdi>{row.date}</bdi> ·{" "}
                {row.sessions.length ? (
                  <bdi>
                    {row.sessions
                      .map((s) => `${s.startTime}–${s.endTime}`)
                      .join(", ")}
                  </bdi>
                ) : (
                  t.noSession
                )}
              </p>
              {row.bookings.length > 0 && (
                <ul>
                  {row.bookings.map((b) => (
                    <li key={b.id}>
                      <bdi>
                        {b.bookingNumber} · {b.patientName}
                      </bdi>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
          <p role="status">{t.affected(affected)}</p>
          {affected > 0 && <p>{t.mustCancel}</p>}
          <p>{t.draftOnly}</p>
          <button
            type="button"
            className="staff-button staff-button-primary"
            disabled={task.busy || !pending.length}
            onClick={saveAbsence}
          >
            {t.confirmAbsence}
          </button>
        </div>
      )}
    </div>
  );
}
