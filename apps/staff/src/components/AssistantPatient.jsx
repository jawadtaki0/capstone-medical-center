import { useEffect, useId, useState } from "react";
import PhoneInput from "./PhoneInput.jsx";
import {
  PATIENT_FIELDS,
  patientInput,
  patientToday,
} from "../../shared/patient-input.js";
import { useTask } from "./useTask.js";
import { TEXT } from "./assistantText.js";

const name = (p) =>
  [p.firstName, p.fatherName, p.lastName].filter(Boolean).join(" ");

// Finds an existing record, or collects registration details without saving.
export default function AssistantPatient({
  api,
  language,
  prefill,
  onError,
  onPick,
  onRegister,
}) {
  const t = TEXT[language],
    id = useId();
  // Its own request guard: sessions may be loading at the same moment.
  const { busy, error, run } = useTask(onError);
  const [search, setSearch] = useState({
      firstName: prefill.firstName ?? "",
      lastName: prefill.lastName ?? "",
      dateOfBirth: prefill.dateOfBirth ?? "",
      patientNumber: prefill.patientNumber ?? "",
    }),
    [found, setFound] = useState(null),
    [record, setRecord] = useState(null),
    [errors, setErrors] = useState({}),
    [message, setMessage] = useState(""),
    [matches, setMatches] = useState(null),
    [different, setDifferent] = useState(false),
    [reason, setReason] = useState("");

  async function find() {
    // A patient number identifies one record; otherwise use every value given.
    const query = search.patientNumber
      ? { patientNumber: search.patientNumber.trim().toUpperCase() }
      : Object.fromEntries(Object.entries(search).filter(([, v]) => v.trim()));
    if (!Object.keys(query).length) return setMessage(t.searchNeeds);
    setMessage("");
    const result = await run(() => api.searchPatients(query));
    if (result) setFound(result.patients);
  }
  useEffect(() => {
    if (Object.values(search).some(Boolean)) find();
  }, []);

  function startRegistration() {
    setRecord(
      Object.fromEntries(
        PATIENT_FIELDS.map((k) => [k, prefill[k] ?? search[k] ?? ""]),
      ),
    );
    setMatches(null);
  }
  function change(field, value) {
    setRecord({ ...record, [field]: value });
    setErrors({});
    setMatches(null);
    setDifferent(false);
    setReason("");
    setMessage("");
  }
  async function useDetails(event) {
    event.preventDefault();
    const checked = patientInput(record, patientToday());
    setErrors(checked.errors);
    if (Object.keys(checked.errors).length) return setMessage(t.missing);
    const duplicates =
      matches && (matches.candidates.length || matches.hasMore);
    if (duplicates && (!different || !reason.trim()))
      return setMessage(t.reasonNeeded);
    const review =
      matches ??
      (await run(() => api.checkPatientDuplicates({ record: checked.record })));
    if (!review) return;
    if (!matches && (review.candidates.length || review.hasMore)) {
      setMatches(review);
      return setMessage("");
    }
    onRegister({
      record: checked.record,
      reviewDigest: review.reviewDigest,
      ...(duplicates
        ? {
            duplicateOverride: { acknowledged: true, reason: reason.trim() },
          }
        : {}),
    });
  }
  const list = (patients) => (
    <ul className="booking-list">
      {patients.map((p) => (
        <li key={p.id}>
          <p>
            <bdi>{name(p)}</bdi> · <bdi>{p.patientNumber}</bdi> ·{" "}
            {t.dateOfBirth} <bdi>{p.dateOfBirth}</bdi>
          </p>
          <button
            type="button"
            className="staff-button"
            disabled={busy}
            onClick={() => onPick(p)}
          >
            {t.select}
          </button>
        </li>
      ))}
    </ul>
  );
  const field = (key, values, onChange, type = "text") => (
    <label className="staff-field" key={key} htmlFor={`${id}-${key}`}>
      {t[key]}
      <input
        id={`${id}-${key}`}
        type={type}
        dir="auto"
        value={values[key]}
        aria-invalid={errors[key] ? true : undefined}
        onChange={(e) => onChange(key, e.target.value)}
      />
    </label>
  );

  if (record)
    return (
      <form className="staff-form" onSubmit={useDetails} noValidate>
        <h2>{t.register}</h2>
        <fieldset disabled={busy} className="staff-form-grid booking-fields">
          {["firstName", "fatherName", "lastName", "motherFirstName"].map(
            (key) => field(key, record, change),
          )}
          {field("dateOfBirth", record, change, "date")}
          <PhoneInput
            label={t.phone}
            defaultValue={record.phone}
            error={errors.phone}
            onValueChange={(value) => change("phone", value)}
          />
          <label className="staff-field">
            {t.gender}
            <select
              value={record.gender}
              aria-invalid={errors.gender ? true : undefined}
              onChange={(e) => change("gender", e.target.value)}
            >
              <option value="" disabled>
                {t.choose}
              </option>
              <option value="female">{t.female}</option>
              <option value="male">{t.male}</option>
            </select>
          </label>
        </fieldset>
        {matches && (
          <div className="staff-idle-warning">
            <p>{t.duplicates}</p>
            {list(matches.candidates)}
            <label className="staff-confirm">
              <input
                type="checkbox"
                checked={different}
                onChange={(e) => setDifferent(e.target.checked)}
              />
              {t.different}
            </label>
            <label className="staff-field">
              {t.reason}
              <input
                dir="auto"
                maxLength={500}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
          </div>
        )}
        {(message || error) && (
          <p className="staff-error" role="alert">
            {message || error}
          </p>
        )}
        <div className="staff-actions">
          <button
            type="submit"
            className="staff-button staff-button-primary"
            disabled={busy}
          >
            {t.useDetails}
          </button>
          <button
            type="button"
            className="staff-button"
            disabled={busy}
            onClick={() => setRecord(null)}
          >
            {t.change}
          </button>
        </div>
      </form>
    );
  return (
    <form
      className="staff-form"
      onSubmit={(event) => {
        event.preventDefault();
        find();
      }}
    >
      <h2>{t.patient}</h2>
      <fieldset disabled={busy} className="staff-form-grid booking-fields">
        {["firstName", "lastName", "dateOfBirth", "patientNumber"].map((key) =>
          field(
            key,
            search,
            (k, value) => {
              setSearch({ ...search, [k]: value });
              setFound(null);
            },
            key === "dateOfBirth" ? "date" : "text",
          ),
        )}
      </fieldset>
      {message && (
        <p className="staff-error" role="alert">
          {message}
        </p>
      )}
      <div className="staff-actions">
        <button
          type="submit"
          className="staff-button staff-button-primary"
          disabled={busy}
        >
          {t.find}
        </button>
        {onRegister && (
          <button
            type="button"
            className="staff-button"
            disabled={busy}
            onClick={startRegistration}
          >
            {t.register}
          </button>
        )}
      </div>
      {error && (
        <p className="staff-error" role="alert">
          {error}
        </p>
      )}
      {found && <p role="status">{found.length ? t.pick : t.noPatient}</p>}
      {found && list(found)}
    </form>
  );
}
