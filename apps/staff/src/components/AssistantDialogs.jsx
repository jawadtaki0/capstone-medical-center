import { useEffect, useState } from "react";
import LoadingStatus from "../../../../shared/ui/LoadingStatus.jsx";
import OperationalPublish from "./OperationalPublish.jsx";
import OperationalEditor from "./OperationalEditor.jsx";
import PatientEditor from "./PatientEditor.jsx";
import AssistantPatient from "./AssistantPatient.jsx";
import { cleanOperationalRecord, newSession } from "../lib/operations.js";
import { matchProfessionals } from "../lib/assistantSchedule.js";
import { useTask } from "./useTask.js";
import { TEXT } from "./assistantText.js";
import "./operations.css";
import "./patients.css";
import "./bookings.css";

// These automations open the same dialogs as their screens, so the review,
// verification and confirmation rules are identical.
function useOperations({ api, onError }) {
  const task = useTask(onError);
  const [state, setState] = useState(null);
  async function load() {
    const result = await task.run(() => api.operationalState());
    if (result) setState(result);
    return result;
  }
  useEffect(() => {
    load();
  }, []);
  return { task, state, load };
}

function Done({ message }) {
  return (
    <p role="status" className="staff-notice assistant-done">
      <strong>{message}</strong>
    </p>
  );
}

export function AssistantPublish(props) {
  const { api, language, onSensitiveAction, onDone } = props,
    t = TEXT[language];
  const { task, state } = useOperations(props);
  const [open, setOpen] = useState(false),
    [done, setDone] = useState("");
  if (done) return <Done message={done} />;
  return (
    <div className="assistant-task">
      {task.busy && <LoadingStatus label="Checking…" />}
      {task.error && (
        <p className="staff-error" role="alert">
          {task.error}
        </p>
      )}
      <p>{t.publishHint}</p>
      <button
        type="button"
        className="staff-button staff-button-primary"
        disabled={!state}
        onClick={() => setOpen(true)}
      >
        {t.reviewWebsite}
      </button>
      {open && (
        <div dir="ltr">
          <OperationalPublish
            state={state}
            onReview={(payload) => api.reviewOperationalChanges(payload)}
            onClose={() => setOpen(false)}
            onPublish={async (payload) => {
              await onSensitiveAction(() =>
                api.publishOperationalDrafts(payload),
              );
              setDone(t.published);
              onDone(t.published);
            }}
          />
        </div>
      )}
    </div>
  );
}

export function AssistantHours(props) {
  const { api, language, question, onSensitiveAction, onDone } = props,
    t = TEXT[language];
  const { task, state, load } = useOperations(props);
  const [professional, setProfessional] = useState(""),
    [editor, setEditor] = useState(null),
    [done, setDone] = useState("");
  const people =
    state?.professionals.filter((p) => p.canEdit && p.active) ?? [];
  useEffect(() => {
    const named = matchProfessionals(question, people);
    if (named.length === 1) setProfessional(named[0].id);
  }, [state]);
  const sessions = (state?.sessions ?? []).filter(
    (s) => s.professionalId === professional,
  );
  const clinic = state?.scopes.find(
    (s) => s.kind === "clinic" && s.active && s.access.edit,
  );
  return (
    <div className="assistant-task">
      {done && <Done message={done} />}
      {state && (
        <label className="staff-field">
          {t.doctor}
          <select
            value={professional}
            onChange={(e) => setProfessional(e.target.value)}
          >
            <option value="" disabled>
              {t.choose}
            </option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {task.busy && <LoadingStatus label="Checking…" />}
      {task.error && (
        <p className="staff-error" role="alert">
          {task.error}
        </p>
      )}
      {professional && (
        <>
          <ul className="booking-list">
            {sessions.map((s) => (
              <li key={s.id} className="assistant-chosen">
                <p>
                  {t.days[s.weekday]}{" "}
                  <bdi>
                    {s.startTime}–{s.endTime}
                  </bdi>
                </p>
                <button
                  type="button"
                  className="staff-button"
                  onClick={() => setEditor(s)}
                >
                  {t.editSession}
                </button>
              </li>
            ))}
          </ul>
          {clinic && (
            <button
              type="button"
              className="staff-button"
              onClick={() =>
                setEditor({
                  ...newSession(clinic.id, 1),
                  professionalId: professional,
                })
              }
            >
              {t.addSession}
            </button>
          )}
          <p className="staff-help">{t.hoursHint}</p>
        </>
      )}
      {editor && (
        <div dir="ltr">
          <OperationalEditor
            type="sessions"
            initial={editor}
            state={state}
            onClose={() => setEditor(null)}
            onSave={async (record, expectedRevision) => {
              await onSensitiveAction(() =>
                api.saveOperationalRecord({
                  type: "sessions",
                  record: cleanOperationalRecord("sessions", record),
                  expectedRevision,
                }),
              );
              await load();
              setDone(t.sessionSaved);
              onDone(t.sessionSaved);
            }}
          />
        </div>
      )}
    </div>
  );
}

export function AssistantPatientUpdate({
  api,
  language,
  prefill,
  onError,
  onDone,
}) {
  const t = TEXT[language];
  const [patient, setPatient] = useState(null),
    [done, setDone] = useState("");
  if (done) return <Done message={done} />;
  return (
    <div className="assistant-task">
      <AssistantPatient
        api={api}
        language={language}
        prefill={prefill}
        onError={onError}
        onPick={setPatient}
      />
      {patient && (
        <div dir="ltr">
          <PatientEditor
            api={api}
            patient={patient}
            onClose={() => setPatient(null)}
            onSaved={(saved) => {
              const message = t.patientSaved(saved.patientNumber);
              setPatient(null);
              setDone(message);
              onDone(message);
            }}
            onOpen={setPatient}
            onError={onError}
          />
        </div>
      )}
    </div>
  );
}
