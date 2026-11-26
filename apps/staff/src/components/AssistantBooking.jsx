import { useRef, useState } from "react";
import AssistantPatient from "./AssistantPatient.jsx";
import AssistantSessions from "./AssistantSessions.jsx";
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
    run = useRef(null);
  const task = useTask(onError);
  const [patient, setPatient] = useState(null),
    [registration, setRegistration] = useState(null),
    [selected, setSelected] = useState(null),
    [review, setReview] = useState(null),
    [noticeLanguage, setNoticeLanguage] = useState(language),
    [receipt, setReceipt] = useState(null),
    [note, setNote] = useState(""),
    [picker, setPicker] = useState(0);

  function reset() {
    run.current = null;
    setReview(null);
    setNote("");
  }
  function choose(session) {
    reset();
    setSelected(session);
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
          setPicker((n) => n + 1);
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

      <AssistantSessions
        key={picker}
        api={api}
        language={language}
        today={today}
        initialDate={prefill.date >= today ? prefill.date : today}
        initialProfessional={prefill.professionalId}
        autoLoad={Boolean(prefill.date || prefill.professionalId || picker)}
        selected={selected}
        onSelect={choose}
        onError={onError}
      />

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
