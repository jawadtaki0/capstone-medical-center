import { useEffect, useId, useRef, useState } from "react";
import OperationalDialog from "./OperationalDialog.jsx";
import PhoneInput from "./PhoneInput.jsx";
import { PHONE_INPUT_MESSAGE } from "../../shared/contact-input.js";
import {
  PATIENT_FIELDS,
  PATIENT_LABELS,
  patientInput,
  patientToday,
} from "../../shared/patient-input.js";
import { isAccessError } from "../lib/staffManagement.js";

export default function PatientEditor({
  api,
  patient,
  onClose,
  onSaved,
  onOpen,
  onError,
}) {
  const id = useId(),
    live = useRef(true),
    generation = useRef(0),
    pending = useRef(false),
    summary = useRef(null);
  const [record, setRecord] = useState(() =>
      Object.fromEntries(PATIENT_FIELDS.map((k) => [k, patient[k] ?? ""])),
    ),
    [errors, setErrors] = useState({}),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [review, setReview] = useState(null),
    [ack, setAck] = useState(false),
    [reason, setReason] = useState(""),
    [discard, setDiscard] = useState(false);
  const initial = useRef(JSON.stringify(record)),
    dirty = JSON.stringify(record) !== initial.current;
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      generation.current++;
    };
  }, []);
  useEffect(() => {
    if (review) summary.current?.focus();
  }, [review]);
  function change(field, value) {
    setRecord({ ...record, [field]: value });
    setReview(null);
    setAck(false);
    setReason("");
    setErrors({});
    setError("");
  }
  function close() {
    if (pending.current) return;
    if (dirty && !discard) {
      setDiscard(true);
      return;
    }
    onClose();
  }
  async function submit(event) {
    event.preventDefault();
    if (pending.current) return;
    const checked = patientInput(record, patientToday());
    setErrors(checked.errors);
    if (Object.keys(checked.errors).length) {
      setError("Check the highlighted patient fields.");
      return;
    }
    const input = {
      record: checked.record,
      ...(patient.id
        ? { patientId: patient.id, expectedRevision: patient.revision }
        : {}),
    };
    if (
      review &&
      (review.candidates.length || review.hasMore) &&
      (!ack || !reason.trim())
    ) {
      setError(
        "Acknowledge the possible matches and record why this is a distinct patient.",
      );
      return;
    }
    pending.current = true;
    setBusy(true);
    setError("");
    const version = ++generation.current;
    try {
      const result = review
        ? await api[patient.id ? "updatePatient" : "createPatient"]({
            ...input,
            reviewDigest: review.reviewDigest,
            ...(review.candidates.length || review.hasMore
              ? {
                  duplicateOverride: {
                    acknowledged: ack,
                    reason: reason.trim(),
                  },
                }
              : {}),
          })
        : await api.checkPatientDuplicates(input);
      if (!live.current || version !== generation.current) return;
      if (result.patient) {
        onSaved(result.patient);
        return;
      }
      setReview(result);
      setAck(false);
      setReason("");
      if (result.reviewRequired)
        setError(
          "The registry changed or a duplicate review is required. Compare the current matches before saving again.",
        );
    } catch (value) {
      if (live.current && version === generation.current) {
        setError(
          value.message || "The patient record was not saved. Try again.",
        );
        if (value.code === "patient_stale") setReview(null);
        if (isAccessError(value)) onError?.(value);
      }
    } finally {
      pending.current = false;
      if (live.current && version === generation.current) setBusy(false);
    }
  }
  function renderField(field) {
    return (
      <div className={"staff-field patient-field-" + field} key={field}>
        <label htmlFor={id + "-" + field}>{PATIENT_LABELS[field]}</label>
        {field === "gender" ? (
          <select
            id={id + "-" + field}
            value={record[field]}
            onChange={(e) => change(field, e.target.value)}
            disabled={busy}
            required
            aria-invalid={Boolean(errors[field])}
            aria-describedby={
              errors[field] ? id + "-" + field + "-error" : undefined
            }
          >
            <option value="" disabled>
              Choose gender
            </option>
            <option value="female">Female</option>
            <option value="male">Male</option>
          </select>
        ) : (
          <input
            id={id + "-" + field}
            type={field === "dateOfBirth" ? "date" : "text"}
            max={field === "dateOfBirth" ? patientToday() : undefined}
            maxLength={field === "dateOfBirth" ? undefined : 80}
            value={record[field]}
            onChange={(e) => change(field, e.target.value)}
            disabled={busy}
            required
            autoComplete="off"
            spellCheck={false}
            aria-invalid={Boolean(errors[field])}
            aria-describedby={
              errors[field] ? id + "-" + field + "-error" : undefined
            }
          />
        )}
        {errors[field] && (
          <p className="staff-field-error" id={id + "-" + field + "-error"}>
            {errors[field]}
          </p>
        )}
      </div>
    );
  }
  return (
    <OperationalDialog titleId={`${id}-title`} busy={busy} onClose={close}>
      <h2 id={`${id}-title`}>
        {patient.id ? "Edit patient" : "Register new patient"}
      </h2>
      <p className="staff-help">
        {patient.patientNumber
          ? `Patient number: ${patient.patientNumber} · cannot be changed.`
          : "A unique patient number is assigned only when the record is saved."}{" "}
        No patient portal account is created.
      </p>
      <form className="staff-form" onSubmit={submit} noValidate>
        <div className="staff-form-grid">
          {PATIENT_FIELDS.slice(0, 4).map(renderField)}
        </div>
        <div className="patient-contact-grid">
          {renderField("dateOfBirth")}
          <PhoneInput
            label="Phone number"
            defaultValue={patient.phone ?? ""}
            onValueChange={(value) => change("phone", value)}
            error={errors.phone ? PHONE_INPUT_MESSAGE : ""}
            disabled={busy}
            className="patient-phone-field"
            validateOnBlur={false}
          />
          {renderField("gender")}
        </div>
        <p className="staff-help">
          Shared family phones are allowed. A valid format does not verify
          ownership.
        </p>
        {error && (
          <p className="staff-error" role="alert">
            {error}
          </p>
        )}
        {review && (
          <section
            className="patient-duplicate-review"
            aria-labelledby={`${id}-review`}
          >
            <h3 ref={summary} tabIndex={-1} id={`${id}-review`}>
              Duplicate review
            </h3>
            <p className="staff-help">
              Names are compared separately using whitespace/case normalization
              and a conservative one-character difference for longer names. No
              records are merged automatically.
            </p>
            {!review.candidates.length && !review.hasMore ? (
              <p role="status">
                No similar records found. The server checks again when you save.
              </p>
            ) : (
              <>
                <p role="status">
                  Compare these records before continuing. Phone matches are
                  supporting evidence only.
                </p>
                {review.hasMore && (
                  <p className="staff-error">
                    More possible matches exist than can be shown here. Search
                    more precisely to compare them, or explain why this is a
                    distinct patient.
                  </p>
                )}
                <ul className="patient-candidates">
                  {review.candidates.map((p) => (
                    <li key={p.id}>
                      <h4>
                        {p.classification === "strong"
                          ? "Strong warning"
                          : "Possible match"}{" "}
                        · {p.patientNumber}
                      </h4>
                      <dl className="patient-summary">
                        {[
                          "firstName",
                          "fatherName",
                          "lastName",
                          "motherFirstName",
                          "dateOfBirth",
                          "phone",
                        ].map((k) => (
                          <div key={k}>
                            <dt>{PATIENT_LABELS[k]}</dt>
                            <dd>{p[k]}</dd>
                          </div>
                        ))}
                      </dl>
                      {p.dateDiscrepancy && (
                        <p className="patient-date-warning">
                          Date discrepancy: entered {p.dateDiscrepancy.entered};
                          existing {p.dateDiscrepancy.existing}.
                        </p>
                      )}
                      <p className="staff-help">
                        {p.phoneMatch
                          ? "Phone also matches; families may share a phone."
                          : "Phone is different; this does not rule out a duplicate."}
                      </p>
                      <button
                        type="button"
                        className="staff-button staff-button-secondary"
                        disabled={busy}
                        onClick={() => onOpen(p.id)}
                      >
                        Open existing record
                      </button>
                    </li>
                  ))}
                </ul>
                <label className="patient-ack">
                  <input
                    type="checkbox"
                    checked={ack}
                    disabled={busy}
                    onChange={(e) => setAck(e.target.checked)}
                  />
                  I compared the possible matches and confirm this is a distinct
                  patient.
                </label>
                <div className="staff-field">
                  <label htmlFor={`${id}-reason`}>
                    Reason for continuing with this patient record
                  </label>
                  <textarea
                    id={`${id}-reason`}
                    rows={3}
                    maxLength={500}
                    value={reason}
                    disabled={busy}
                    onChange={(e) => setReason(e.target.value)}
                  />
                </div>
              </>
            )}
          </section>
        )}
        {discard ? (
          <div
            className="patient-discard"
            role="group"
            aria-label="Discard unsaved patient changes"
          >
            <p>Discard these unsaved changes?</p>
            <button
              type="button"
              className="staff-button staff-button-secondary"
              onClick={() => setDiscard(false)}
            >
              Keep editing
            </button>
            <button
              type="button"
              className="staff-button staff-button-primary"
              onClick={onClose}
            >
              Discard changes
            </button>
          </div>
        ) : (
          <div className="staff-actions">
            <button
              type="submit"
              className="staff-button staff-button-primary"
              disabled={busy}
            >
              {busy
                ? "Checking…"
                : review
                  ? patient.id
                    ? "Save changes"
                    : "Register patient"
                  : "Check duplicates"}
            </button>
            <button
              type="button"
              className="staff-button staff-button-secondary"
              disabled={busy}
              onClick={close}
            >
              Cancel
            </button>
          </div>
        )}
      </form>
    </OperationalDialog>
  );
}
