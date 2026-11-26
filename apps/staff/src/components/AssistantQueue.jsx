import { useEffect, useRef, useState } from "react";
import AssistantPatient from "./AssistantPatient.jsx";
import LoadingStatus from "../../../../shared/ui/LoadingStatus.jsx";
import { centerToday } from "../lib/operations.js";
import { useTask } from "./useTask.js";
import { TEXT } from "./assistantText.js";
import "./bookings.css";
import "./patients.css";

const selection = (s) => ({
  date: s.date,
  scopeId: s.scopeId,
  sourceSessionId: s.sourceSessionId,
  sessionVersion: s.scheduleSignature,
});

// Check-in and walk-in use today's Queue endpoints; extra admissions stay on
// the Queue screen.
export default function AssistantQueue({
  api,
  type,
  language,
  prefill,
  onError,
  onDone,
}) {
  const t = TEXT[language],
    walkIn = type === "walkin",
    key = useRef(null),
    task = useTask(onError);
  const [sessions, setSessions] = useState(null),
    [session, setSession] = useState(null),
    [rows, setRows] = useState(null),
    [query, setQuery] = useState(
      [prefill.firstName, prefill.lastName].filter(Boolean).join(" "),
    ),
    [booking, setBooking] = useState(null),
    [patient, setPatient] = useState(null),
    [registration, setRegistration] = useState(null),
    [done, setDone] = useState("");

  async function choose(next) {
    key.current = null;
    setSession(next);
    setBooking(null);
    setRows(null);
    if (!next || walkIn) return;
    const list = await task.run(() => api.queueList(selection(next)));
    if (list) setRows(list.bookings);
  }
  useEffect(() => {
    task
      .run(() => api.queueSessions({ date: centerToday() }))
      .then((result) => {
        if (!result) return;
        setSessions(result.sessions);
        if (result.sessions.length === 1) choose(result.sessions[0]);
      });
  }, []);

  async function confirm() {
    key.current ??= crypto.randomUUID();
    const result = await task.run(() =>
      walkIn
        ? api.queueAdmit({
            ...selection(session),
            kind: "walk_in",
            ...(patient
              ? { patientId: patient.id, patientRevision: patient.revision }
              : { patientCreate: registration }),
            idempotencyKey: key.current,
          })
        : api.checkInPatient({
            ...selection(session),
            bookingId: booking.id,
            expectedRevision: 0,
            idempotencyKey: key.current,
          }),
    );
    if (!result) return;
    if (result.reviewRequired) {
      key.current = null;
      setRegistration(null);
      return;
    }
    const name = walkIn
      ? [
          (patient ?? registration.record).firstName,
          (patient ?? registration.record).lastName,
        ].join(" ")
      : booking.patientName;
    const message = walkIn ? t.walkedIn(name) : t.checkedIn(name);
    setDone(message);
    onDone(message);
  }

  if (done)
    return (
      <p role="status" className="staff-notice assistant-done">
        <strong>{done}</strong>
      </p>
    );
  const label = (s) => `${s.professionalName} · ${s.startTime}–${s.endTime}`;
  const waiting = (rows ?? []).filter(
    (b) =>
      b.status === "confirmed" &&
      !b.queue &&
      query
        .toLowerCase()
        .split(/\s+/)
        .every((word) =>
          `${b.patientName} ${b.patientNumber} ${b.bookingNumber}`
            .toLowerCase()
            .includes(word),
        ),
  );
  const person = patient ?? registration?.record;
  const ready = session && (walkIn ? person : booking);
  return (
    <div className="assistant-task">
      {sessions && (
        <label className="staff-field">
          {t.todaySession}
          <select
            value={session?.id ?? ""}
            disabled={task.busy}
            onChange={(e) =>
              choose(sessions.find((s) => s.id === e.target.value))
            }
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
      )}
      {sessions && !sessions.length && <p role="status">{t.noQueueSessions}</p>}
      {!walkIn && session && rows && (
        <>
          <label className="staff-field">
            {t.findBooking}
            <input
              dir="auto"
              maxLength={80}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setBooking(null);
                key.current = null;
              }}
            />
          </label>
          <p role="status">{waiting.length ? t.pickBooking : t.noBooking}</p>
          <ul className="booking-list">
            {waiting.slice(0, 10).map((b) => (
              <li key={b.id}>
                <p>
                  <bdi>{b.patientName}</bdi> · <bdi>{b.bookingNumber}</bdi>
                </p>
                <button
                  type="button"
                  className="staff-button"
                  aria-pressed={booking?.id === b.id}
                  disabled={task.busy}
                  onClick={() => {
                    key.current = null;
                    setBooking(b);
                  }}
                >
                  {t.select}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {walkIn &&
        session &&
        (person ? (
          <div className="assistant-chosen">
            <p>
              <strong>{t.patient}: </strong>
              <bdi>
                {person.firstName} {person.lastName}
              </bdi>{" "}
              · <bdi>{patient ? patient.patientNumber : t.newPatient}</bdi>
            </p>
            <button
              type="button"
              className="staff-button"
              disabled={task.busy}
              onClick={() => {
                key.current = null;
                setPatient(null);
                setRegistration(null);
              }}
            >
              {t.change}
            </button>
          </div>
        ) : (
          <AssistantPatient
            api={api}
            language={language}
            prefill={prefill}
            onError={onError}
            onPick={setPatient}
            onRegister={setRegistration}
          />
        ))}
      {task.busy && <LoadingStatus label="Checking…" />}
      {task.error && (
        <p className="staff-error" role="alert">
          {task.error} {ready && t.retry}
        </p>
      )}
      {ready && (
        <div className="staff-action-confirmation">
          <p>
            <bdi>
              {walkIn
                ? `${person.firstName} ${person.lastName}`
                : `${booking.patientName} · ${booking.bookingNumber}`}
            </bdi>
          </p>
          <p>
            <bdi>{label(session)}</bdi>
          </p>
          <button
            type="button"
            className="staff-button staff-button-primary"
            disabled={task.busy}
            onClick={confirm}
          >
            {walkIn ? t.confirmWalkIn : t.confirmCheckIn}
          </button>
        </div>
      )}
    </div>
  );
}
