import { REQUEST_REASONS } from "../../../../shared/website-request-contract.mjs";
import { useEffect, useId, useRef, useState } from "react";
import OperationalDialog from "./OperationalDialog.jsx";
import { isAccessError } from "../lib/staffManagement.js";

export default function BookingRecords({
  api,
  date,
  scopeId,
  affected = false,
  onError,
  refresh = 0,
}) {
  const id = useId(),
    generation = useRef(0),
    lock = useRef(false);
  const [result, setResult] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [target, setTarget] = useState(null),
    [reason, setReason] = useState(""),
    [publicReason, setPublicReason] = useState("");
  async function load(cursor) {
    const n = ++generation.current;
    setBusy(true);
    setError("");
    try {
      const value = affected
        ? await api.affectedBookings(cursor ? { cursor } : {})
        : await api.listBookings({
            date,
            scopeId,
            ...(cursor ? { cursor } : {}),
          });
      if (n === generation.current) setResult(value);
    } catch (e) {
      if (n === generation.current) {
        setError(e.message);
        if (
          isAccessError(e) &&
          String(e.code).toLowerCase() !== "authority_unavailable"
        )
          onError?.(e);
      }
    } finally {
      if (n === generation.current) setBusy(false);
    }
  }
  useEffect(() => {
    setResult(null);
    load();
    return () => {
      generation.current++;
    };
  }, [api, date, scopeId, affected, refresh]);
  async function cancel(e) {
    e.preventDefault();
    if (!publicReason) {
      setError("Choose a fixed patient-facing cancellation reason.");
      return;
    }
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    const n = ++generation.current;
    try {
      await api.cancelBooking({ bookingId: target.id, reason, publicReason });
      if (n === generation.current) {
        setTarget(null);
        setReason("");
        setNotice(
          "Booking cancelled. Its place was released once; the history is retained.",
        );
        await load();
      }
    } catch (e) {
      if (n === generation.current) {
        setError(e.message);
        if (
          isAccessError(e) &&
          String(e.code).toLowerCase() !== "authority_unavailable"
        )
          onError?.(e);
      }
    } finally {
      lock.current = false;
      if (n === generation.current) setBusy(false);
    }
  }
  return (
    <section
      className="staff-workspace-card booking-records"
      aria-label={affected ? "Affected bookings" : "Dated booking list"}
    >
      <h2>
        {affected
          ? "Active bookings — publication review"
          : `Bookings for ${date}`}
      </h2>
      {affected && (
        <p className="staff-help">
          Review the affected date, professional and session before publishing.
          Schedule managers can view their clinic’s bookings; cancellation
          requires Admin or an explicitly assigned Receptionist. No booking is
          moved or cancelled automatically.
        </p>
      )}
      {error && (
        <p role="alert" className="staff-error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <button
        type="button"
        className="staff-button"
        disabled={busy}
        onClick={() => load()}
      >
        {" "}
        {busy ? "Loading bookings…" : "Reload bookings"}
      </button>
      {result?.bookings.length === 0 && (
        <p>No {affected ? "active " : ""}bookings found.</p>
      )}
      <ul className="booking-list">
        {result?.bookings.map((b) => (
          <li key={b.id}>
            <h3>
              {b.bookingNumber} ·{" "}
              {b.status === "confirmed" ? "Confirmed" : "Cancelled"}
            </h3>
            <p>
              {b.patientName} · {b.patientNumber}
            </p>
            <p>
              {b.date} · {b.professionalName} · {b.startTime}–{b.endTime}
            </p>
            {b.cancellationReason && (
              <p>Cancellation: {b.cancellationReason}</p>
            )}
            {b.status === "confirmed" && (b.canCancel ?? result.canCancel) && (
              <button
                type="button"
                className="staff-button"
                disabled={busy}
                onClick={() => {
                  setTarget(b);
                  setPublicReason("");
                  setReason("");
                  setError("");
                }}
              >
                Cancel booking {b.bookingNumber}
              </button>
            )}
          </li>
        ))}
      </ul>
      {result?.nextCursor && (
        <button
          type="button"
          className="staff-button"
          disabled={busy}
          onClick={() => load(result.nextCursor)}
        >
          Next bookings
        </button>
      )}
      {target && (
        <OperationalDialog
          titleId={`${id}-cancel`}
          busy={busy}
          onClose={() => {
            setTarget(null);
            setReason("");
          }}
        >
          <label className="staff-field">
            Patient-facing cancellation reason
            <select
              aria-label="Patient-facing cancellation reason"
              required
              value={publicReason}
              onChange={(e) => setPublicReason(e.target.value)}
            >
              <option value="" disabled>
                Choose a fixed reason
              </option>
              {Object.entries(REQUEST_REASONS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v.en}
                </option>
              ))}
            </select>
          </label>
          <h2 id={`${id}-cancel`}>Cancel {target.bookingNumber}?</h2>
          <p>
            {target.patientName} · {target.date} · {target.startTime}–
            {target.endTime}. This releases one place and retains the booking
            history.
          </p>
          <form className="staff-form" onSubmit={cancel}>
            <label className="staff-field">
              Cancellation reason
              <input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={240}
                required
                disabled={busy}
              />
            </label>
            {error && (
              <p role="alert" className="staff-error">
                {error}
              </p>
            )}
            <div className="staff-actions">
              <button
                className="staff-button staff-button-primary"
                disabled={busy}
                type="submit"
              >
                Confirm cancellation
              </button>
              <button
                className="staff-button"
                disabled={busy}
                type="button"
                onClick={() => {
                  setTarget(null);
                  setReason("");
                }}
              >
                Keep booking
              </button>
            </div>
          </form>
        </OperationalDialog>
      )}
    </section>
  );
}
