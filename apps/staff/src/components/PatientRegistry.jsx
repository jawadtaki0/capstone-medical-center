import { useEffect, useId, useRef, useState } from "react";
import PatientEditor from "./PatientEditor.jsx";
import { PATIENT_LABELS } from "../../shared/patient-input.js";
import { isAccessError } from "../lib/staffManagement.js";
import "./patients.css";

const searchFields = [
  "firstName",
  "fatherName",
  "lastName",
  "motherFirstName",
  "dateOfBirth",
  "phone",
  "patientNumber",
];
const emptySearch = () => Object.fromEntries(searchFields.map((k) => [k, ""]));
export default function PatientRegistry({ api, onError, onPendingChange }) {
  const id = useId(),
    live = useRef(true),
    generation = useRef(0),
    pending = useRef(false),
    opener = useRef(null),
    wasEditing = useRef(false),
    resultsHeading = useRef(null),
    callbacks = useRef({ onError, onPendingChange });
  callbacks.current = { onError, onPendingChange };
  const [query, setQuery] = useState(emptySearch),
    [results, setResults] = useState(null),
    [searched, setSearched] = useState(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [editor, setEditor] = useState(null);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      generation.current++;
      callbacks.current.onPendingChange?.(false);
    };
  }, []);
  useEffect(() => {
    callbacks.current.onPendingChange?.(Boolean(editor || busy));
    if (editor) wasEditing.current = true;
    else if (wasEditing.current && !busy) {
      wasEditing.current = false;
      const target = opener.current;
      if (target?.isConnected && !target.disabled) target.focus();
      else resultsHeading.current?.focus();
    }
  }, [editor, busy]);
  function failure(value) {
    setError(
      value.message || "The patient request could not be completed. Try again.",
    );
    if (isAccessError(value)) callbacks.current.onError?.(value);
  }
  async function run(action) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    const version = ++generation.current;
    try {
      const value = await action();
      if (live.current && version === generation.current) return value;
    } catch (value) {
      if (live.current && version === generation.current) failure(value);
    } finally {
      pending.current = false;
      if (live.current && version === generation.current) setBusy(false);
    }
  }
  async function search(cursor) {
    const input = cursor
      ? { ...searched, cursor }
      : Object.fromEntries(Object.entries(query).filter(([, v]) => v.trim()));
    if (!Object.keys(input).length) {
      setError(
        "Enter at least one search criterion. Use two or more characters for a name.",
      );
      return;
    }
    const found = await run(() => api.searchPatients(input));
    if (found) {
      setResults(found);
      setSearched(cursor ? searched : input);
      setNotice("");
    }
  }
  async function open(patientId, button) {
    if (button) opener.current = button;
    const found = await run(() => api.readPatient({ patientId }));
    if (found) {
      setEditor(found.patient);
      setNotice("");
    }
  }
  function close() {
    setEditor(null);
  }
  return (
    <section className="patient-registry" aria-labelledby={`${id}-heading`}>
      <p className="staff-eyebrow">PRIVATE · SHARED STAFF REGISTRY</p>
      <h1 id={`${id}-heading`} tabIndex={-1}>
        Patients
      </h1>
      <p className="staff-intro">
        Search before registering. Compare names and dates carefully; a shared
        family phone does not identify a patient. These records are not portal
        accounts.
      </p>
      <form
        className="staff-form patient-search"
        onSubmit={(event) => {
          event.preventDefault();
          void search();
        }}
      >
        <h2>Find an existing patient</h2>
        <div className="staff-form-grid">
          {searchFields.map((field) => (
            <div className="staff-field" key={field}>
              <label htmlFor={`${id}-${field}`}>
                {PATIENT_LABELS[field] ?? "Patient number"}
              </label>
              <input
                id={`${id}-${field}`}
                type={
                  field === "dateOfBirth"
                    ? "date"
                    : field === "phone"
                      ? "tel"
                      : "text"
                }
                value={query[field]}
                onChange={(e) => {
                  setQuery({ ...query, [field]: e.target.value });
                  setSearched(null);
                  setResults(null);
                }}
                disabled={busy}
                maxLength={field === "patientNumber" ? 18 : 80}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
          ))}
        </div>
        <p className="staff-help">
          Names are searched separately by their beginning. Enter a full phone
          number or patient number for an exact match. Mother’s maiden name
          means her first name only.
        </p>
        <div className="staff-actions">
          <button
            type="submit"
            className="staff-button staff-button-primary"
            disabled={busy}
          >
            {busy ? "Searching…" : "Search patients"}
          </button>
          <button
            type="button"
            className="staff-button staff-button-secondary"
            disabled={busy}
            onClick={() => {
              setQuery(emptySearch());
              setResults(null);
              setSearched(null);
              setError("");
              setNotice("");
            }}
          >
            Clear search
          </button>
        </div>
      </form>
      {error && (
        <p role="alert" className="staff-error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="staff-success">
          {notice}
        </p>
      )}
      {results && (
        <section aria-labelledby={`${id}-results`}>
          <div className="patient-results-heading">
            <h2 ref={resultsHeading} tabIndex={-1} id={`${id}-results`}>
              Search results
            </h2>
            <button
              type="button"
              className="staff-button staff-button-primary"
              disabled={busy}
              onClick={(event) => {
                opener.current = event.currentTarget;
                setEditor({});
                setNotice("");
              }}
            >
              Register new patient
            </button>
          </div>
          <p role="status">
            {results.patients.length
              ? `${results.patients.length} records on this page${results.nextCursor ? "; more results available" : ""}.`
              : "No matching patients found. You can register a new patient after comparing your search."}
          </p>
          <ul className="patient-results">
            {results.patients.map((p) => (
              <li key={p.id}>
                <div>
                  <h3>
                    {p.firstName} {p.lastName}
                  </h3>
                  <p className="staff-help">{p.patientNumber}</p>
                  <dl className="patient-summary">
                    <div>
                      <dt>Father’s name</dt>
                      <dd>{p.fatherName}</dd>
                    </div>
                    <div>
                      <dt>Mother’s first name</dt>
                      <dd>{p.motherFirstName}</dd>
                    </div>
                    <div>
                      <dt>Date of birth</dt>
                      <dd>{p.dateOfBirth}</dd>
                    </div>
                    <div>
                      <dt>Phone</dt>
                      <dd>{p.phone}</dd>
                    </div>
                  </dl>
                </div>
                <button
                  type="button"
                  className="staff-button staff-button-secondary"
                  disabled={busy}
                  onClick={(event) => void open(p.id, event.currentTarget)}
                >
                  Open patient
                </button>
              </li>
            ))}
          </ul>
          {results.nextCursor && (
            <button
              type="button"
              className="staff-button staff-button-secondary"
              disabled={busy}
              onClick={() => void search(results.nextCursor)}
            >
              Next page
            </button>
          )}
        </section>
      )}
      {editor && (
        <PatientEditor
          api={api}
          patient={editor}
          onError={onError}
          onClose={close}
          onOpen={async (patientId) => {
            setEditor(null);
            await open(patientId);
          }}
          onSaved={(p) => {
            setEditor(null);
            setNotice(`Patient ${p.patientNumber} saved.`);
            setResults({ patients: [p], nextCursor: null });
          }}
        />
      )}
    </section>
  );
}
