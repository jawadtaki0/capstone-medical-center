import { useEffect, useRef, useState } from "react";
import AssistantSessions from "./AssistantSessions.jsx";
import { BookingNoticeButton } from "./RequestNoticeDialog.jsx";
import LoadingStatus from "../../../../shared/ui/LoadingStatus.jsx";
import { REQUEST_REASONS } from "../../../../shared/website-request-contract.mjs";
import { useTask } from "./useTask.js";
import { TEXT } from "./assistantText.js";
import "./bookings.css";

// Cancel or reschedule: staff select the booking, then confirm once.
export default function AssistantChange({
  api,
  type,
  language,
  prefill,
  today,
  onError,
}) {
  const t = TEXT[language],
    moving = type === "reschedule",
    key = useRef(null);
  const task = useTask(onError);
  const [query, setQuery] = useState(
      prefill.bookingNumber ??
        prefill.patientNumber ??
        [prefill.firstName, prefill.lastName].filter(Boolean).join(" "),
    ),
    [found, setFound] = useState(null),
    [booking, setBooking] = useState(null),
    [session, setSession] = useState(null),
    [reason, setReason] = useState(""),
    [publicReason, setPublicReason] = useState(""),
    [noticeLanguage, setNoticeLanguage] = useState(language),
    [done, setDone] = useState(null);

  async function search() {
    const result = await task.run(() =>
      api.upcomingBookings({ query: query.trim() }),
    );
    if (result) setFound(result);
  }
  useEffect(() => {
    if (query) search();
  }, []);

  // Any change to what would be sent needs a new confirmation key.
  const changed = (apply) => (value) => {
    key.current = null;
    apply(value);
  };
  async function confirm() {
    key.current ??= crypto.randomUUID();
    const result = await task.run(() =>
      moving
        ? api.rescheduleBooking({
            bookingId: booking.id,
            date: session.date,
            scopeId: session.scopeId,
            sourceSessionId: session.sourceSessionId,
            sessionVersion: session.version,
            idempotencyKey: key.current,
            publicReason,
            noticeLanguage,
          })
        : api.cancelBooking({
            bookingId: booking.id,
            reason: reason.trim(),
            publicReason,
          }),
    );
    if (result) setDone(result);
  }

  const summary = (b) => (
    <>
      <bdi>{b.patientName}</bdi>
      {b.bookingNumber && (
        <>
          {" "}
          · <bdi>{b.bookingNumber}</bdi>
        </>
      )}{" "}
      · <bdi>{b.date}</bdi> · <bdi>{b.professionalName}</bdi> ·{" "}
      <bdi>
        {b.startTime}–{b.endTime}
      </bdi>
    </>
  );

  if (done)
    return (
      <div role="status" className="staff-notice assistant-done">
        <p>
          <strong>
            {moving
              ? t.moved(booking.bookingNumber, done.booking.bookingNumber)
              : done.replayed
                ? t.already(done.booking.bookingNumber)
                : t.cancelled(done.booking.bookingNumber)}
          </strong>
        </p>
        <p>{summary(done.booking)}</p>
        <p>{t.manual}</p>
        <BookingNoticeButton
          api={api}
          bookingId={done.booking.id}
          onError={onError}
        />
      </div>
    );

  const ready = moving
    ? session && publicReason
    : reason.trim() && publicReason;
  return (
    <div className="assistant-task">
      {!booking ? (
        <form
          className="staff-form"
          onSubmit={(event) => {
            event.preventDefault();
            search();
          }}
        >
          <div className="staff-field">
            <label>
              {t.findBooking}
              <div className="staff-search-control">
                <input
                  dir="auto"
                  maxLength={80}
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setFound(null);
                  }}
                />
                <button
                  type="submit"
                  className="staff-button staff-button-primary"
                  disabled={task.busy || query.trim().length < 2}
                >
                  {t.search}
                </button>
              </div>
            </label>
          </div>
          {found && (
            <p role="status">
              {found.bookings.length ? t.pickBooking : t.noBooking}{" "}
              {found.more && t.more}
            </p>
          )}
          <ul className="booking-list">
            {found?.bookings.map((b) => (
              <li key={b.id}>
                <p>{summary(b)}</p>
                <button
                  type="button"
                  className="staff-button"
                  disabled={task.busy}
                  onClick={() => changed(setBooking)(b)}
                >
                  {t.select}
                </button>
              </li>
            ))}
          </ul>
        </form>
      ) : (
        <>
          <div className="assistant-chosen">
            <p>
              <strong>{t.current}: </strong>
              {summary(booking)}
            </p>
            <button
              type="button"
              className="staff-button"
              disabled={task.busy}
              onClick={() => {
                changed(setBooking)(null);
                setSession(null);
              }}
            >
              {t.change}
            </button>
          </div>
          {moving && (
            <AssistantSessions
              key={booking.id}
              api={api}
              language={language}
              today={today}
              initialDate={prefill.date >= today ? prefill.date : booking.date}
              initialProfessional={booking.professionalId}
              excludeId={booking.datedSessionId}
              autoLoad
              selected={session}
              onSelect={changed(setSession)}
              onError={onError}
            />
          )}
          {!moving && (
            <label className="staff-field">
              {t.internalReason}
              <input
                dir="auto"
                maxLength={240}
                value={reason}
                onChange={(e) => changed(setReason)(e.target.value)}
              />
            </label>
          )}
          <label className="staff-field">
            {t.publicReason}
            <select
              value={publicReason}
              onChange={(e) => changed(setPublicReason)(e.target.value)}
            >
              <option value="" disabled>
                {t.choose}
              </option>
              {Object.entries(REQUEST_REASONS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label[language]}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
      {task.busy && <LoadingStatus label="Checking…" />}
      {task.error && (
        <p className="staff-error" role="alert">
          {task.error} {ready && t.retry}
        </p>
      )}
      {booking && ready && (
        <div className="staff-action-confirmation">
          <p>
            <strong>{t.current}: </strong>
            {summary(booking)}
          </p>
          {moving && (
            <>
              <p>
                <strong>{t.replacement}: </strong>
                {summary({ ...session, patientName: booking.patientName })}
              </p>
              <label className="staff-field">
                {t.language}
                <select
                  value={noticeLanguage}
                  onChange={(e) => changed(setNoticeLanguage)(e.target.value)}
                >
                  <option value="en">English</option>
                  <option value="ar">العربية</option>
                </select>
              </label>
            </>
          )}
          <p>{t.nothingYet}</p>
          <button
            type="button"
            className="staff-button staff-button-primary"
            disabled={task.busy}
            onClick={confirm}
          >
            {moving ? t.confirmMove : t.confirmCancel}
          </button>
        </div>
      )}
    </div>
  );
}
