import { useEffect, useId, useRef, useState } from "react";
import OperationalDialog from "./OperationalDialog.jsx";
import BookingRecords from "./BookingRecords.jsx";
import { centerToday } from "../lib/operations.js";
import { isAccessError } from "../lib/staffManagement.js";
import "./bookings.css";

export default function BookingPanel({ api, onError, onPendingChange }) {
  const id = useId(),
    generation = useRef(0),
    pending = useRef(false),
    reviewOpener = useRef(null),
    hadReview = useRef(false),
    callbacks = useRef({ onError, onPendingChange });
  callbacks.current = { onError, onPendingChange };
  const [search, setSearch] = useState({
      firstName: "",
      lastName: "",
      patientNumber: "",
    }),
    [patients, setPatients] = useState(null),
    [searched, setSearched] = useState(null),
    [patient, setPatient] = useState(null),
    [date, setDate] = useState(centerToday()),
    [availability, setAvailability] = useState(null),
    [professional, setProfessional] = useState(""),
    [selected, setSelected] = useState(""),
    [scope, setScope] = useState(""),
    [review, setReview] = useState(null),
    [receipt, setReceipt] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [refresh, setRefresh] = useState(0);
  useEffect(
    () => () => {
      generation.current++;
      callbacks.current.onPendingChange?.(false);
    },
    [],
  );
  useEffect(() => {
    callbacks.current.onPendingChange?.(Boolean(review || busy));
    if (review) hadReview.current = true;
    else if (hadReview.current && !busy) {
      hadReview.current = false;
      if (reviewOpener.current?.isConnected && !reviewOpener.current.disabled)
        reviewOpener.current.focus();
    }
  }, [review, busy]);
  async function run(action) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    const n = ++generation.current;
    try {
      const value = await action();
      if (n === generation.current) return value;
    } catch (e) {
      if (n === generation.current) {
        setError(e.message);
        // Keep the confirmation/key for an uncertain individual request. The
        // existing session monitor still clears this whole view on real loss
        // of authority, expiry or revocation; retries always authenticate again.
        if (
          isAccessError(e) &&
          String(e.code).toLowerCase() !== "authority_unavailable"
        )
          callbacks.current.onError?.(e);
      }
    } finally {
      pending.current = false;
      if (n === generation.current) setBusy(false);
    }
  }
  async function find(e, cursor) {
    e?.preventDefault();
    const query = cursor
      ? { ...searched, cursor }
      : Object.fromEntries(Object.entries(search).filter(([, v]) => v.trim()));
    const value = await run(() => api.searchPatients(query));
    if (value) {
      setPatients(value);
      setSearched(cursor ? searched : query);
      setPatient(null);
      setReceipt(null);
    }
  }
  async function load() {
    const value = await run(() => api.bookingSessions({ date }));
    if (value) {
      setAvailability(value);
      setScope(value.scopes[0]?.id ?? "");
      setProfessional("");
      setSelected("");
      setReceipt(null);
      setRefresh((n) => n + 1);
    }
  }
  async function openReview(event) {
    reviewOpener.current = event.currentTarget;
    const s = availability.sessions.find((s) => s.id === selected);
    if (!patient || !s) return;
    const input = {
      patientId: patient.id,
      patientRevision: patient.revision,
      date: availability.date,
      scopeId: s.scopeId,
      sourceSessionId: s.sourceSessionId,
    };
    const value = await run(() => api.reviewBooking(input));
    if (value)
      setReview({
        ...value,
        request: {
          ...input,
          sessionVersion: value.session.version,
          idempotencyKey: crypto.randomUUID(),
        },
      });
  }
  async function confirm() {
    const value = await run(() => api.confirmBooking(review.request));
    // On uncertain transport outcomes the SAME review/key remains available.
    if (value) {
      setReceipt(value.booking);
      setReview(null);
      setRefresh((n) => n + 1);
      setAvailability(null);
    }
  }
  const professionals = [
    ...new Map(
      (availability?.sessions ?? []).map((s) => [
        s.professionalId,
        s.professionalName,
      ]),
    ).entries(),
  ];
  return (
    <div className="booking-panel">
      <p className="staff-eyebrow">CLINIC BOOKINGS</p>
      <h1 tabIndex={-1}>Bookings</h1>
      <p>
        A booking reserves a place in the full session window, not an exact
        appointment time. Actual check-in determines consultation order.
      </p>
      {error && !review && (
        <p role="alert" className="staff-error">
          {error}
        </p>
      )}
      {receipt && (
        <div role="status" className="staff-workspace-card">
          <h2>
            {receipt.status === "confirmed"
              ? "Booking confirmed"
              : "Original booking was cancelled"}
          </h2>
          <p>
            Booking number: <strong>{receipt.bookingNumber}</strong>
          </p>
          <p>
            {receipt.patientName} · {receipt.date} · {receipt.professionalName}{" "}
            · {receipt.startTime}–{receipt.endTime}
          </p>
          <p>
            Keep this immutable booking number. This does not assign a
            consultation time.
          </p>
        </div>
      )}
      <section className="staff-workspace-card">
        <h2>1. Search and select an existing patient</h2>
        <form className="staff-form" onSubmit={find}>
          <fieldset disabled={busy} className="staff-form-grid booking-fields">
            <legend>Patient search</legend>
            {[
              ["firstName", "First name"],
              ["lastName", "Last name"],
              ["patientNumber", "Patient number"],
            ].map(([key, label]) => (
              <label className="staff-field" key={key} htmlFor={`${id}-${key}`}>
                {label}
                <input
                  id={`${id}-${key}`}
                  value={search[key]}
                  onChange={(e) =>
                    setSearch({ ...search, [key]: e.target.value })
                  }
                />
              </label>
            ))}
          </fieldset>
          <button
            className="staff-button staff-button-primary"
            disabled={busy}
            type="submit"
          >
            Search patients
          </button>
        </form>
        {patients?.patients.length === 0 && (
          <p role="status">
            No matching patients. Register a patient in Patients first.
          </p>
        )}
        <ul className="booking-list">
          {patients?.patients.map((p) => (
            <li key={p.id}>
              <p>
                {p.firstName} {p.fatherName} {p.lastName} · {p.patientNumber} ·
                DOB {p.dateOfBirth}
              </p>
              <button
                type="button"
                className="staff-button"
                disabled={busy}
                aria-pressed={patient?.id === p.id}
                onClick={() => {
                  setPatient(p);
                  setReceipt(null);
                }}
              >
                {patient?.id === p.id ? "Selected" : "Select"} {p.patientNumber}
              </button>
            </li>
          ))}
        </ul>
        {patients?.nextCursor && (
          <button
            type="button"
            className="staff-button"
            disabled={busy}
            onClick={() => find(null, patients.nextCursor)}
          >
            Next patients
          </button>
        )}
      </section>
      <section className="staff-workspace-card">
        <h2>2. Choose a published clinic session</h2>
        <p className="staff-help">
          Private limits apply immediately. Website receiver delivery does not
          determine staff availability. Laboratory and Audiometry bookings are
          not included.
        </p>
        <div className="staff-form-grid booking-fields">
          <label className="staff-field" htmlFor={`${id}-date`}>
            Session date (Asia/Beirut)
            <input
              id={`${id}-date`}
              type="date"
              value={date}
              disabled={busy}
              onChange={(e) => {
                setDate(e.target.value);
                setAvailability(null);
                setSelected("");
              }}
            />
          </label>
          <button
            type="button"
            className="staff-button"
            disabled={busy || !date}
            onClick={load}
          >
            {busy ? "Loading…" : "Load sessions"}
          </button>
        </div>
        {availability && (
          <>
            <div className="staff-field">
              <label htmlFor={`${id}-professional`}>Professional</label>
              <select
                id={`${id}-professional`}
                disabled={busy}
                value={professional}
                onChange={(e) => {
                  setProfessional(e.target.value);
                  setSelected("");
                }}
              >
                <option value="" disabled>
                  Choose a professional
                </option>
                {professionals.map(([key, name]) => (
                  <option value={key} key={key}>
                    {name}
                  </option>
                ))}
              </select>
            </div>
            {!availability.sessions.length && (
              <p role="status">
                No published, unended clinic sessions on this date.
              </p>
            )}
            <div className="booking-list">
              {availability.sessions
                .filter((s) => s.professionalId === professional)
                .map((s) => (
                  <label className="booking-session" key={s.id}>
                    <input
                      type="radio"
                      name={`${id}-session`}
                      checked={selected === s.id}
                      disabled={busy || !s.canBook}
                      onChange={() => {
                        setSelected(s.id);
                        setScope(s.scopeId);
                      }}
                    />
                    <span>
                      <strong>
                        {s.professionalName} · {s.startTime}–{s.endTime}
                      </strong>
                      <br />
                      {s.clinicName} ·{" "}
                      {s.capacity === null
                        ? "Patient limit: Not configured"
                        : `${s.remaining} remaining of ${s.capacity} (${s.confirmed} confirmed)`}
                      <br />
                      {s.appointmentRequired
                        ? "Appointment required; walk-ins prohibited."
                        : "Full-session booking."}
                      {!s.canBook &&
                        " View only — this role cannot confirm bookings."}
                    </span>
                  </label>
                ))}
            </div>
            <button
              type="button"
              className="staff-button staff-button-primary"
              disabled={busy || !patient || !selected}
              onClick={openReview}
            >
              Review booking
            </button>
          </>
        )}
      </section>
      {scope && (
        <BookingRecords
          api={api}
          date={date}
          scopeId={scope}
          onError={onError}
          refresh={refresh}
        />
      )}
      {review && (
        <OperationalDialog
          titleId={`${id}-review`}
          busy={busy}
          onClose={() => {
            setReview(null);
            setError("");
          }}
        >
          <h2 id={`${id}-review`}>Review and confirm booking</h2>
          <p>
            {review.patient.firstName} {review.patient.fatherName}{" "}
            {review.patient.lastName} · {review.patient.patientNumber}
          </p>
          <p>
            {review.session.date} · {review.session.professionalName} ·{" "}
            {review.session.startTime}–{review.session.endTime} (Asia/Beirut)
          </p>
          <p>
            {review.session.remaining === null
              ? "Patient limit: Not configured — confirmation is blocked."
              : `${review.session.remaining} remaining of ${review.session.capacity}`}
          </p>
          <p>
            No exact appointment time is assigned. Check-in determines order.
            Availability is checked again when you confirm.
          </p>
          {review.overlaps.length > 0 && (
            <div role="status" className="staff-idle-warning">
              <p>
                Warning: this patient has another overlapping booking. You may
                still confirm.
              </p>
              <ul>
                {review.overlaps.map((b) => (
                  <li key={b.id}>
                    {b.bookingNumber} · {b.professionalName} · {b.startTime}–
                    {b.endTime}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {error && (
            <p className="staff-error" role="alert">
              {error} If the outcome is uncertain, retry Confirm booking without
              changing these details.
            </p>
          )}
          <div className="staff-actions">
            <button
              className="staff-button staff-button-primary"
              type="button"
              disabled={busy || !review.session.remaining}
              onClick={confirm}
            >
              {busy ? "Confirming…" : "Confirm booking"}
            </button>
            <button
              className="staff-button"
              type="button"
              disabled={busy}
              onClick={() => {
                setReview(null);
                setError("");
              }}
            >
              Back to selection
            </button>
          </div>
        </OperationalDialog>
      )}
    </div>
  );
}
