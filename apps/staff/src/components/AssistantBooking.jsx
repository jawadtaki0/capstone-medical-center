import { useEffect, useId, useRef, useState } from "react";
import AssistantPatient from "./AssistantPatient.jsx";
import { BookingNoticeButton } from "./RequestNoticeDialog.jsx";
import LoadingStatus from "../../../../shared/ui/LoadingStatus.jsx";
import { createBookingRun } from "../lib/assistantBooking.js";
import { useTask } from "./useTask.js";
import { TEXT } from "./assistantText.js";
import "./bookings.css";
import "./patients.css";

// Guided register-and-book. Typed text only pre-fills; one button saves.
export default function AssistantBooking({
  api,
  language,
  prefill,
  today,
  onError,
}) {
  const t = TEXT[language],
    id = useId(),
    run = useRef(null);
  const task = useTask(onError);
  const [patient, setPatient] = useState(null),
    [registration, setRegistration] = useState(null),
    [date, setDate] = useState(prefill.date >= today ? prefill.date : today),
    [sessions, setSessions] = useState(null),
    [professional, setProfessional] = useState(prefill.professionalId ?? ""),
    [selected, setSelected] = useState(null),
    [alternatives, setAlternatives] = useState(null),
    [review, setReview] = useState(null),
    [noticeLanguage, setNoticeLanguage] = useState(language),
    [receipt, setReceipt] = useState(null),
    [note, setNote] = useState("");

  function reset() {
    run.current = null;
    setReview(null);
    setNote("");
  }
  async function load(day = date) {
    reset();
    setSelected(null);
    setAlternatives(null);
    const result = await task.run(() => api.bookingSessions({ date: day }));
    if (result) setSessions(result.sessions.filter((s) => s.canBook));
  }
  useEffect(() => {
    if (prefill.date || prefill.professionalId) load();
  }, []);

  function choose(session) {
    reset();
    setSelected(session);
  }
  async function other(session, specialty) {
    const result = await task.run(() =>
      api.assistantAlternatives({
        professionalId: session.professionalId,
        date,
        ...(specialty ? { specialty: session.specialty } : {}),
      }),
    );
    if (result) setAlternatives({ ...result, session, specialty });
  }
  async function openReview() {
    let overlaps = [];
    if (patient) {
      const result = await task.run(() =>
        api.reviewBooking({
          patientId: patient.id,
          patientRevision: patient.revision,
          date: selected.date,
          scopeId: selected.scopeId,
          sourceSessionId: selected.sourceSessionId,
        }),
      );
      if (!result) return;
      overlaps = result.overlaps;
      setSelected({ ...selected, ...result.session });
    }
    setReview({ overlaps });
  }
  async function confirm() {
    run.current ??= createBookingRun({
      api,
      session: selected,
      patient,
      registration,
      noticeLanguage,
    });
    setNote("");
    const result = await task.run(
      () => run.current.confirm(),
      (error) => {
        // Registration succeeded and booking did not: say exactly that.
        if (error.patientSaved) {
          setPatient(error.patientSaved);
          setRegistration(null);
          setSelected(null);
          setSessions(null);
          setReview(null);
          run.current = null;
          setNote(t.partly(error.patientSaved.patientNumber));
        }
      },
    );
    if (result?.booking) setReceipt(result.booking);
    else if (result?.reviewRequired) {
      run.current = null;
      setRegistration(null);
      setReview(null);
      setNote(t.checkAgain);
    }
  }

  if (receipt)
    return (
      <div role="status" className="staff-notice assistant-done">
        <p>
          <strong>{t.booked(receipt.bookingNumber)}</strong>
        </p>
        <p>
          <bdi>{receipt.patientName}</bdi> · <bdi>{receipt.date}</bdi> ·{" "}
          <bdi>{receipt.professionalName}</bdi> ·{" "}
          <bdi>
            {receipt.startTime}–{receipt.endTime}
          </bdi>
        </p>
        <BookingNoticeButton
          api={api}
          bookingId={receipt.id}
          onError={onError}
        />
      </div>
    );

  const person = patient ?? registration?.record;
  const professionals = [
    ...new Map(
      (sessions ?? []).map((s) => [s.professionalId, s.professionalName]),
    ),
  ];
  // A pre-filled doctor who is not on this date must not hide everyone else.
  const filter = professionals.some(([key]) => key === professional)
    ? professional
    : "";
  const shown = (sessions ?? []).filter(
    (s) => !filter || s.professionalId === filter,
  );
  const places = (s) =>
    s.capacity === null
      ? t.unset
      : s.remaining
        ? t.remaining(s.remaining, s.capacity)
        : t.full;
  const row = (s) => (
    <label className="booking-session" key={s.id}>
      <input
        type="radio"
        name={`${id}-session`}
        checked={selected?.id === s.id}
        disabled={task.busy || !s.remaining}
        onChange={() => choose(s)}
      />
      <span>
        <strong>
          <bdi>{s.professionalName}</bdi> · <bdi>{s.date}</bdi> ·{" "}
          <bdi>
            {s.startTime}–{s.endTime}
          </bdi>
        </strong>
        <br />
        <bdi>{s.clinicName}</bdi> · {places(s)}
      </span>
    </label>
  );

  return (
    <div className="assistant-task">
      {note && (
        <p className="staff-error" role="alert">
          {note}
        </p>
      )}
      {person ? (
        <div className="assistant-chosen">
          <p>
            <strong>{t.patient}: </strong>
            <bdi>
              {person.firstName} {person.fatherName} {person.lastName}
            </bdi>{" "}
            · <bdi>{patient ? patient.patientNumber : t.newPatient}</bdi>
          </p>
          <button
            type="button"
            className="staff-button"
            disabled={task.busy}
            onClick={() => {
              reset();
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
          onPick={(p) => {
            reset();
            setPatient(p);
          }}
          onRegister={(value) => {
            reset();
            setRegistration(value);
          }}
        />
      )}

      <h2>{t.session}</h2>
      <div className="staff-form-grid booking-fields">
        <label className="staff-field">
          {t.date}
          <input
            type="date"
            min={today}
            value={date}
            disabled={task.busy}
            onChange={(e) => {
              reset();
              setDate(e.target.value);
              setSessions(null);
              setSelected(null);
              setAlternatives(null);
            }}
          />
        </label>
        <button
          type="button"
          className="staff-button"
          disabled={task.busy || !date}
          onClick={() => load()}
        >
          {t.load}
        </button>
      </div>
      {sessions && !shown.length && <p role="status">{t.noSessions}</p>}
      <div className="booking-list">{shown.map(row)}</div>
      {filter && professionals.length > 1 && (
        <button
          type="button"
          className="staff-button"
          onClick={() => setProfessional("")}
        >
          {t.allProfessionals}
        </button>
      )}
      <div className="staff-actions">
        {shown
          .filter((s) => s.capacity !== null && !s.remaining)
          .map((s) => (
            <button
              key={s.id}
              type="button"
              className="staff-button"
              disabled={task.busy}
              onClick={() => other(s, false)}
            >
              {t.otherDates(s.professionalName)}
            </button>
          ))}
      </div>
      {alternatives && (
        <>
          {alternatives.sessions.length ? (
            <div className="booking-list">{alternatives.sessions.map(row)}</div>
          ) : (
            <p role="status">{t.noAlternatives(alternatives.days)}</p>
          )}
          {!alternatives.specialty && !alternatives.sessions.length && (
            <button
              type="button"
              className="staff-button"
              disabled={task.busy}
              onClick={() => other(alternatives.session, true)}
            >
              {t.otherDoctors(alternatives.session.specialty)}
            </button>
          )}
        </>
      )}

      {task.busy && <LoadingStatus label="Checking…" />}
      {task.error && (
        <p className="staff-error" role="alert">
          {task.error} {review && t.retry}
        </p>
      )}
      {!review ? (
        <button
          type="button"
          className="staff-button staff-button-primary"
          disabled={task.busy || !person || !selected}
          onClick={openReview}
        >
          {t.review}
        </button>
      ) : (
        <div className="staff-action-confirmation">
          <p>
            <bdi>
              {person.firstName} {person.fatherName} {person.lastName}
            </bdi>{" "}
            · <bdi>{patient ? patient.patientNumber : t.newPatient}</bdi>
          </p>
          <p>
            <bdi>{selected.date}</bdi> · <bdi>{selected.professionalName}</bdi>{" "}
            ·{" "}
            <bdi>
              {selected.startTime}–{selected.endTime}
            </bdi>
          </p>
          {review.overlaps.length > 0 && <p role="status">{t.overlap}</p>}
          <label className="staff-field">
            {t.language}
            <select
              value={noticeLanguage}
              disabled={task.busy}
              onChange={(e) => {
                // A different request needs a new confirmation key.
                run.current = null;
                setNoticeLanguage(e.target.value);
              }}
            >
              <option value="en">English</option>
              <option value="ar">العربية</option>
            </select>
          </label>
          <p>{t.nothingYet}</p>
          <button
            type="button"
            className="staff-button staff-button-primary"
            disabled={task.busy}
            onClick={confirm}
          >
            {registration ? t.confirmBoth : t.confirm}
          </button>
        </div>
      )}
    </div>
  );
}
