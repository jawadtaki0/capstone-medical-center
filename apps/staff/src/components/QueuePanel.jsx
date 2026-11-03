import { useEffect, useId, useRef, useState } from "react";
import { centerToday } from "../lib/operations.js";
import { isAccessError } from "../lib/staffManagement.js";
import "./queue.css";
import QueueAdmission from "./QueueAdmission.jsx";

const time = (at) =>
  at
    ? new Intl.DateTimeFormat("en-GB", {
        timeZone: "Asia/Beirut",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(at))
    : "—";
const number = (value) => (value ? `#${String(value).padStart(2, "0")}` : "—");
const selection = (s) => ({
  date: s.date,
  scopeId: s.scopeId,
  sourceSessionId: s.sourceSessionId,
  sessionVersion: s.scheduleSignature,
});
const stateLabels = {
  open: "Check-in open",
  not_open: "Check-in not open yet",
  ended: "Check-in ended",
};

const statusName = (value) =>
  ({
    waiting: "Waiting",
    called: "Called",
    in_consultation: "In consultation",
    completed: "Completed",
    temporarily_absent: "Temporarily absent",
    left: "Left",
    no_show: "No-show",
  })[value] ?? value;
const changeName = (value) =>
  ({
    callNext: "call",
    outOfOrder: "call",
    start: "consultation start",
    complete: "completion",
    absent: "absence",
    return: "return",
    left: "departure",
  })[value] ?? "change";
function PatientActions({ patient, busy, onAction }) {
  const state = patient.queue.status;
  return (
    <div className="queue-patient-actions">
      {state === "temporarily_absent" && (
        <button
          type="button"
          className="staff-button staff-button-secondary"
          disabled={busy}
          onClick={() => onAction(patient, "return")}
        >
          Returned—join end
        </button>
      )}
      <details>
        <summary
          aria-label={`More actions for ${number(patient.queue.number)} ${patient.patientName}`}
        >
          More
        </summary>
        <div className="queue-row-menu">
          {["waiting", "called"].includes(state) && (
            <button
              type="button"
              disabled={busy}
              onClick={() => onAction(patient, "absent")}
            >
              Mark absent
            </button>
          )}
          {["waiting", "called", "temporarily_absent"].includes(state) && (
            <button
              type="button"
              disabled={busy}
              onClick={() => onAction(patient, "left")}
            >
              Mark as left
            </button>
          )}
          {state === "waiting" && (
            <button
              type="button"
              disabled={busy}
              onClick={() => onAction(patient, "outOfOrder")}
            >
              Call this patient instead
            </button>
          )}
          {state === "no_show" && (
            <button
              type="button"
              disabled={busy}
              onClick={() => onAction(patient, "restoreArrival")}
            >
              Correct missed arrival
            </button>
          )}
          {patient.queue.lastTransition && (
            <button
              type="button"
              disabled={busy}
              onClick={() => onAction(patient, "correct")}
            >
              Correct last change
            </button>
          )}
        </div>
      </details>
    </div>
  );
}

function QueueTable({ rows, empty, history = false, onManage, busy }) {
  return (
    <div className="queue-table-scroll">
      <table className="queue-table">
        <thead>
          <tr>
            <th scope="col">Number</th>
            <th scope="col">Patient</th>
            <th scope="col">Arrived</th>
            {history && (
              <>
                <th scope="col">Started</th>
                <th scope="col">Finished</th>
              </>
            )}
            <th scope="col">Type</th>
            {history && <th scope="col">Status</th>}
            {onManage && <th scope="col">Actions</th>}
          </tr>
        </thead>
        <tbody>
          {rows.length ? (
            rows.map((b) => (
              <tr key={b.id}>
                <td>
                  <strong>{number(b.queue?.number)}</strong>
                </td>
                <td>{b.patientName}</td>
                <td>
                  {b.queue?.earlierArrivalReported
                    ? "Earlier arrival reported"
                    : time(b.queue?.checkedInAt)}
                </td>
                {history && (
                  <>
                    <td>{time(b.queue?.startedAt)}</td>
                    <td>{time(b.queue?.completedAt ?? b.queue?.leftAt)}</td>
                  </>
                )}
                <td>{b.type}</td>
                {history && (
                  <td>
                    {b.queue?.status === "completed"
                      ? "Completed"
                      : b.queue?.status === "left"
                        ? "Left"
                        : b.queue?.status === "no_show"
                          ? "No-show"
                          : "Cancelled"}
                  </td>
                )}
                {onManage && (
                  <td>
                    <PatientActions
                      patient={b}
                      busy={busy}
                      onAction={onManage}
                    />
                  </td>
                )}
              </tr>
            ))
          ) : (
            <tr>
              <td colSpan={(history ? 7 : 4) + (onManage ? 1 : 0)}>{empty}</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export default function QueuePanel({ api, onError, onPendingChange }) {
  const id = useId(),
    generation = useRef(0),
    pending = useRef(false),
    command = useRef(null),
    callbacks = useRef({ onError, onPendingChange });
  callbacks.current = { onError, onPendingChange };
  const [date, setDate] = useState(centerToday()),
    [sessions, setSessions] = useState([]),
    [professional, setProfessional] = useState(""),
    [selectedId, setSelectedId] = useState(""),
    [snapshot, setSnapshot] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [history, setHistory] = useState("completed");
  const [actionTarget, setActionTarget] = useState(""),
    [queueAction, setQueueAction] = useState("absent"),
    [reason, setReason] = useState(""),
    [instructed, setInstructed] = useState(false);
  const [earlierArrival, setEarlierArrival] = useState(false);
  const [admissionMode, setAdmissionMode] = useState(null);
  const selected = sessions.find((s) => s.id === selectedId);
  const current = snapshot?.session;
  const rows = snapshot?.bookings ?? [];
  const waiting = rows.filter((b) => b.queue?.status === "waiting");
  const active = rows.find((b) =>
    ["called", "in_consultation"].includes(b.queue?.status),
  );
  const transitionCommand = useRef(null);
  const eligible = rows.filter((b) => b.status === "confirmed" && !b.queue);
  const professionals = [
    ...new Map(
      sessions.map((s) => [s.professionalId, s.professionalName]),
    ).entries(),
  ];
  const absent = rows.filter((b) => b.queue?.status === "temporarily_absent");
  const targetPatient = rows.find((b) => b.id === actionTarget);
  function manage(patient, action) {
    if (admissionMode !== null) return;
    setError("");
    setNotice("");
    if (["absent", "left", "return"].includes(action)) {
      void transition(action, patient);
      return;
    }
    setActionTarget(patient.id);
    setQueueAction(action);
    setReason("");
    setInstructed(false);
    setEarlierArrival(false);
  }
  const unknown = !snapshot;
  useEffect(
    () => () => {
      generation.current++;
      callbacks.current.onPendingChange?.(false);
    },
    [],
  );
  useEffect(() => {
    callbacks.current.onPendingChange?.(busy || admissionMode !== null);
  }, [busy, admissionMode]);
  function failure(e) {
    setError(e.message);
    if (
      e.code === "queue_forbidden" ||
      (isAccessError(e) &&
        !String(e.code).toLowerCase().includes("unavailable"))
    ) {
      setSnapshot(null);
      setSessions([]);
      callbacks.current.onError?.(e);
    }
  }
  async function loadSessions() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    const n = ++generation.current;
    setSnapshot(null);
    command.current = null;
    try {
      const value = await api.queueSessions({ date });
      if (n !== generation.current) return;
      setSessions(value.sessions);
      const next =
        value.sessions.find((s) => s.id === selectedId) ?? value.sessions[0];
      setProfessional(next?.professionalId ?? "");
      setSelectedId(next?.id ?? "");
      if (next) {
        const list = await api.queueList(selection(next));
        if (n === generation.current) setSnapshot(list);
      }
    } catch (e) {
      if (n === generation.current) failure(e);
    } finally {
      pending.current = false;
      if (n === generation.current) setBusy(false);
    }
  }
  async function choose(s) {
    if (pending.current || !s) return;
    pending.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    const n = ++generation.current;
    setSelectedId(s.id);
    setProfessional(s.professionalId);
    setSnapshot(null);
    command.current = null;
    try {
      const value = await api.queueList(selection(s));
      if (n === generation.current) setSnapshot(value);
    } catch (e) {
      if (n === generation.current) failure(e);
    } finally {
      pending.current = false;
      if (n === generation.current) setBusy(false);
    }
  }
  async function checkIn(patient) {
    if (pending.current || !current || !patient) return;
    pending.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    const n = ++generation.current;
    const candidate = {
      ...selection(current),
      bookingId: patient.id,
      expectedRevision: 0,
    };
    if (
      !command.current ||
      JSON.stringify(command.current.payload) !== JSON.stringify(candidate)
    )
      command.current = { payload: candidate, key: crypto.randomUUID() };
    try {
      const value = await api.checkInPatient({
        ...command.current.payload,
        idempotencyKey: command.current.key,
      });
      if (n !== generation.current) return;
      command.current = null;
      setNotice(
        `${value.booking.patientName} checked in · ${number(value.booking.queue.number)}.`,
      );
      // Only the authoritative snapshot updates order/counts. A lost refresh never undoes admission.
      setSnapshot(null);
      const list = await api.queueList(selection(current));
      if (n === generation.current) {
        setSnapshot(list);
        return true;
      }
    } catch (e) {
      if (n === generation.current) failure(e);
    } finally {
      pending.current = false;
      if (n === generation.current) setBusy(false);
    }
  }
  function changeDate(value) {
    generation.current++;
    setDate(value);
    setSessions([]);
    setSnapshot(null);
    setSelectedId("");
    setProfessional("");
    setNotice("");
    setError("");
    command.current = null;
  }
  async function transition(action, patient, details = {}) {
    if (pending.current || !current || !patient) return;
    pending.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    const n = ++generation.current;
    const candidate = {
      ...selection(current),
      bookingId: patient.id,
      expectedRevision: patient.queue.revision,
      action,
      ...details,
    };
    if (
      !transitionCommand.current ||
      JSON.stringify(transitionCommand.current.payload) !==
        JSON.stringify(candidate)
    )
      transitionCommand.current = {
        payload: candidate,
        key: crypto.randomUUID(),
      };
    try {
      await api.queueTransition({
        ...candidate,
        idempotencyKey: transitionCommand.current.key,
      });
      if (n !== generation.current) return;
      transitionCommand.current = null;
      setSnapshot(null);
      const list = await api.queueList(selection(current));
      if (n === generation.current) {
        setSnapshot(list);
        return true;
      }
    } catch (e) {
      if (n === generation.current) failure(e);
    } finally {
      pending.current = false;
      if (n === generation.current) setBusy(false);
    }
  }
  const historyRows =
    history === "cancelled"
      ? rows.filter((b) => b.status === "cancelled")
      : history === "completed"
        ? rows.filter((b) => b.queue?.status === "completed")
        : history === "left"
          ? rows.filter((b) => b.queue?.status === "left")
          : rows.filter((b) => b.queue?.status === "no_show");
  return (
    <section
      className="queue-panel"
      aria-labelledby={`${id}-heading`}
      aria-busy={busy}
    >
      <header>
        <h1 id={`${id}-heading`} tabIndex={-1}>
          Patient queue
        </h1>
        <p className="staff-help">
          Arrival order for this professional’s session.
        </p>
      </header>
      <form
        className="queue-session-controls"
        onSubmit={(e) => {
          e.preventDefault();
          void loadSessions();
        }}
      >
        <label className="staff-field">
          Session date (Asia/Beirut)
          <input
            type="date"
            required
            value={date}
            disabled={busy || admissionMode !== null}
            onChange={(e) => changeDate(e.target.value)}
          />
        </label>
        <div className="staff-field">
          <label htmlFor={`${id}-professional`}>Professional</label>
          <select
            id={`${id}-professional`}
            value={professional}
            disabled={busy || admissionMode !== null || !sessions.length}
            onChange={(e) =>
              void choose(
                sessions.find((s) => s.professionalId === e.target.value),
              )
            }
          >
            <option value="" disabled>
              Select professional
            </option>
            {professionals.map(([key, name]) => (
              <option key={key} value={key}>
                {name}
              </option>
            ))}
          </select>
        </div>
        <div className="staff-field">
          <label htmlFor={`${id}-session`}>Session</label>
          <select
            id={`${id}-session`}
            value={selectedId}
            disabled={busy || admissionMode !== null || !selected}
            onChange={(e) =>
              void choose(sessions.find((s) => s.id === e.target.value))
            }
          >
            <option value="" disabled>
              Select session
            </option>
            {sessions
              .filter((s) => s.professionalId === professional)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.startTime} – {s.endTime} · {s.clinicName}
                </option>
              ))}
          </select>
        </div>
        <span
          className={`queue-state ${current?.checkInState === "open" ? "is-open" : ""}`}
        >
          {current ? stateLabels[current.checkInState] : "Select a session"}
        </span>
        <button
          className="staff-button staff-button-secondary"
          type="submit"
          disabled={busy || admissionMode !== null}
        >
          {sessions.length ? "Refresh queue" : "Load sessions"}
        </button>
      </form>
      {error && (
        <p className="staff-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="staff-notice" role="status">
          {notice}
        </p>
      )}
      <div className="staff-actions queue-actions">
        <button
          type="button"
          className="staff-button staff-button-secondary"
          disabled={
            busy ||
            unknown ||
            admissionMode !== null ||
            !snapshot.canAdmit ||
            current.checkInState !== "open"
          }
          onClick={() => {
            setError("");
            setNotice("");
            setActionTarget("");
            setAdmissionMode("walk_in");
          }}
        >
          Accept walk-in
        </button>
        <button
          type="button"
          className="staff-button staff-button-secondary"
          disabled={
            busy ||
            unknown ||
            admissionMode !== null ||
            !snapshot.canAdmit ||
            current.checkInState !== "open"
          }
          onClick={() => {
            setError("");
            setNotice("");
            setActionTarget("");
            setAdmissionMode("extra");
          }}
        >
          Admit extra today
        </button>
      </div>
      {admissionMode !== null && current && (
        <QueueAdmission
          api={api}
          session={current}
          kind={admissionMode}
          onError={onError}
          onClose={() => setAdmissionMode(null)}
          onAdmitted={async (result) => {
            setAdmissionMode(null);
            setNotice(
              `${result.booking.patientName} checked in - ${number(result.booking.queue.number)}.`,
            );
            setSnapshot(null);
            setBusy(true);
            try {
              setSnapshot(await api.queueList(selection(current)));
            } catch (e) {
              failure(e);
            } finally {
              setBusy(false);
            }
          }}
        />
      )}
      {current && !snapshot.canAdmit && (
        <p className="staff-help">
          Only an Admin or clinic-authorized Receptionist can admit patients.
        </p>
      )}
      <section
        className="staff-workspace-card queue-booked"
        aria-labelledby={`${id}-booked`}
      >
        <h2 id={`${id}-booked`}>
          Booked—not arrived{snapshot ? ` · ${eligible.length}` : ""}
        </h2>
        <p className="staff-help">
          {unknown
            ? "Load a session to see its confirmed bookings."
            : current.checkInState === "ended"
              ? "Check-in has ended. New arrivals cannot join this session."
              : current.checkInState === "not_open"
                ? "Check-in opens 30 minutes before the session starts."
                : "Check in the patient when they arrive. Their number follows arrival order."}
        </p>
        <div className="queue-table-scroll">
          <table className="queue-table">
            <thead>
              <tr>
                <th scope="col">Patient</th>
                <th scope="col">Booking</th>
                <th scope="col">Type</th>
                <th scope="col">Action</th>
              </tr>
            </thead>
            <tbody>
              {eligible.length ? (
                eligible.map((b) => (
                  <tr key={b.id}>
                    <td>
                      {b.patientName}
                      <br />
                      <span className="staff-help">{b.patientNumber}</span>
                    </td>
                    <td>{b.bookingNumber}</td>
                    <td>{b.type}</td>
                    <td>
                      <button
                        type="button"
                        className="staff-button staff-button-primary"
                        aria-label={`Check in ${b.patientName}`}
                        disabled={
                          busy ||
                          admissionMode !== null ||
                          current?.checkInState !== "open"
                        }
                        onClick={() => void checkIn(b)}
                      >
                        Check in
                      </button>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={4}>
                    {unknown
                      ? "Booked patients have not been loaded."
                      : "No unarrived confirmed bookings in this session."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
      <p className="staff-help queue-refresh-note" role="status">
        {busy
          ? "Loading queue…"
          : snapshot
            ? `Last refreshed ${time(snapshot.serverNow)} · Asia/Beirut. Refresh to see other staff’s changes.`
            : sessions.length
              ? "Select or refresh a session to load its queue."
              : "Load the selected date to see your authorized sessions."}
      </p>
      {targetPatient && (
        <form
          className="queue-check-in staff-workspace-card"
          onSubmit={async (e) => {
            e.preventDefault();
            const done = await transition(queueAction, targetPatient, {
              reason,
              ...(queueAction === "restoreArrival"
                ? { arrivedBeforeEnd: earlierArrival }
                : {}),
              ...(queueAction === "outOfOrder"
                ? { professionalInstructed: instructed }
                : {}),
            });
            if (done) setActionTarget("");
          }}
        >
          <h2>
            {queueAction === "outOfOrder"
              ? `Call ${number(targetPatient.queue.number)} ${targetPatient.patientName} instead`
              : queueAction === "restoreArrival"
                ? `Correct No-show for ${targetPatient.patientName}`
                : `Undo ${changeName(targetPatient.queue.lastTransition?.action)} for ${number(targetPatient.queue.number)} ${targetPatient.patientName}`}
          </h2>
          <p>
            {queueAction === "outOfOrder"
              ? "Call this waiting patient before the others, as instructed by the professional."
              : queueAction === "restoreArrival"
                ? "Restore this No-show patient to the end of Waiting and assign their first number now. Earlier arrival will be recorded as reported, without an invented arrival time."
                : `Return this patient to ${statusName(targetPatient.queue.lastTransition?.before.status)}. Another call or consultation may prevent this correction.`}
          </p>
          <label className="staff-field">
            Reason
            <input
              required
              maxLength={240}
              value={reason}
              disabled={busy}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          {queueAction === "restoreArrival" && (
            <label>
              <input
                type="checkbox"
                required
                checked={earlierArrival}
                disabled={busy}
                onChange={(e) => setEarlierArrival(e.target.checked)}
              />
              I confirm this patient arrived before the session ended
            </label>
          )}
          {queueAction === "outOfOrder" && (
            <label>
              <input
                type="checkbox"
                required
                checked={instructed}
                disabled={busy}
                onChange={(e) => setInstructed(e.target.checked)}
              />
              The professional instructed this call
            </label>
          )}
          <button
            type="submit"
            className="staff-button staff-button-primary"
            disabled={busy}
          >
            {queueAction === "outOfOrder"
              ? "Call patient"
              : queueAction === "restoreArrival"
                ? "Restore to waiting"
                : `Undo ${changeName(targetPatient.queue.lastTransition?.action)}`}
          </button>
          <button
            type="button"
            className="staff-button staff-button-secondary"
            disabled={busy}
            onClick={() => setActionTarget("")}
          >
            Cancel
          </button>
        </form>
      )}
      <div className="queue-main-grid">
        <section className="staff-workspace-card queue-waiting">
          <h2>Waiting{snapshot ? ` · ${waiting.length}` : ""}</h2>
          <QueueTable
            rows={waiting}
            onManage={manage}
            busy={busy}
            empty={
              unknown
                ? "Waiting list has not been loaded."
                : "No patients waiting in this session."
            }
          />
          <div className="staff-actions">
            <button
              type="button"
              className="staff-button staff-button-primary"
              disabled={
                busy ||
                unknown ||
                snapshot.activeSlotOccupied ||
                !waiting.length
              }
              onClick={() => void transition("callNext", waiting[0])}
            >
              ▶&nbsp; Call next
            </button>
          </div>
        </section>
        <section className="staff-workspace-card queue-active">
          <h2>
            {active?.queue.status === "called"
              ? "Called"
              : active
                ? "In consultation"
                : "Active patient"}
          </h2>
          {active ? (
            <>
              <strong>{number(active.queue.number)}</strong>
              <h3>{active.patientName}</h3>
              <p>
                {active.queue.earlierArrivalReported
                  ? "Earlier arrival reported"
                  : `Checked in ${time(active.queue.checkedInAt)}`}{" "}
                / Called {time(active.queue.calledAt)}
                {active.queue.startedAt
                  ? ` / Started ${time(active.queue.startedAt)}`
                  : ""}
              </p>
            </>
          ) : (
            <p>
              {unknown
                ? "Select a session to view its waiting list."
                : snapshot.activeSlotOccupied
                  ? "This professional has an active patient in another session."
                  : "No active patient."}
            </p>
          )}
          <div className="queue-active-space" />
          {active?.queue.status === "called" && (
            <button
              type="button"
              className="staff-button staff-button-primary"
              disabled={busy}
              onClick={() => void transition("start", active)}
            >
              Start consultation
            </button>
          )}
          {active?.queue.status === "in_consultation" && (
            <button
              type="button"
              className="staff-button staff-button-primary"
              disabled={busy}
              onClick={() => void transition("complete", active)}
            >
              Complete consultation
            </button>
          )}
          {active && (
            <PatientActions patient={active} busy={busy} onAction={manage} />
          )}
          <p className="staff-help">
            Returning joins the end; the number stays the same.
          </p>
        </section>
      </div>
      <section className="staff-workspace-card queue-absent">
        <h2>Temporarily absent</h2>
        <div className="queue-absent-row">
          <QueueTable
            rows={absent}
            onManage={manage}
            busy={busy}
            empty={
              unknown
                ? "Absent list has not been loaded."
                : "No temporarily absent patients."
            }
          />
        </div>
      </section>
      <section className="staff-workspace-card queue-history">
        <div className="queue-history-header">
          <h2>Session history</h2>
          <div className="staff-actions" aria-label="Session history filter">
            {[
              ["completed", "Completed"],
              ["left", "Left"],
              ["no_show", "No-show"],
              ["cancelled", "Cancelled"],
            ].map(([key, label]) => (
              <button
                type="button"
                key={key}
                className={`staff-button ${history === key ? "staff-button-primary" : "staff-button-secondary"}`}
                aria-pressed={history === key}
                onClick={() => setHistory(key)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <QueueTable
          history
          rows={historyRows}
          onManage={history !== "cancelled" ? manage : undefined}
          busy={busy}
          empty={
            unknown
              ? "Session history has not been loaded."
              : history === "completed"
                ? "No completed consultations in this session."
                : history === "cancelled"
                  ? "No cancelled bookings in this session."
                  : history === "left"
                    ? "No patients recorded as Left."
                    : "No unarrived patients recorded as No-show."
          }
        />
      </section>
      {current?.checkInState === "ended" && (
        <p className="staff-help">
          The session has ended. Patients who already arrived can still be seen.
        </p>
      )}
    </section>
  );
}
