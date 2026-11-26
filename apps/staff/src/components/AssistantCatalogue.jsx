import { useEffect, useState } from "react";
import LoadingStatus from "../../../../shared/ui/LoadingStatus.jsx";
import { useTask } from "./useTask.js";
import { TEXT } from "./assistantText.js";
import "./bookings.css";

// One result per line: name | unit | reference interval, as on the Lab screen.
const fieldsFrom = (text) =>
  text
    .split("\n")
    .map((line) => line.split("|").map((part) => part.trim()))
    .filter((parts) => parts.some(Boolean))
    .map(([name = "", unit = "", reference = ""]) => ({
      name,
      unit,
      reference,
    }));

export default function AssistantCatalogue({ api, language, onError, onDone }) {
  const t = TEXT[language],
    task = useTask(onError);
  const [catalogue, setCatalogue] = useState(null),
    [action, setAction] = useState(""),
    [target, setTarget] = useState(null),
    [evidence, setEvidence] = useState(""),
    [entry, setEntry] = useState({
      name: "",
      specimen: "",
      group: "",
      fields: "",
    }),
    [done, setDone] = useState("");

  async function load() {
    const result = await task.run(() => api.lab({ action: "list" }));
    if (result) setCatalogue(result.catalogue);
  }
  useEffect(() => {
    load();
  }, []);
  async function change(payload, message) {
    const result = await task.run(
      () => api.lab(payload),
      () => {
        setTarget(null);
        load();
      },
    );
    if (!result) return;
    setDone(message);
    onDone(message);
  }
  const fields = fieldsFrom(entry.fields);
  const complete =
    entry.name.trim() &&
    entry.specimen.trim() &&
    fields.length > 0 &&
    fields.every((f) => f.name && f.unit && f.reference);

  if (done)
    return (
      <p role="status" className="staff-notice assistant-done">
        <strong>{done}</strong>
      </p>
    );
  return (
    <div className="assistant-task">
      <div className="staff-actions">
        {["add", "approve", "retire"].map((key) => (
          <button
            key={key}
            type="button"
            className="staff-button"
            aria-pressed={action === key}
            onClick={() => {
              setAction(key);
              setTarget(null);
            }}
          >
            {t.catalogueActions[key]}
          </button>
        ))}
      </div>
      {action === "add" && (
        <div className="staff-form">
          {["name", "specimen", "group"].map((key) => (
            <label className="staff-field" key={key}>
              {t.catalogueFields[key]}
              <input
                dir="auto"
                maxLength={250}
                value={entry[key]}
                onChange={(e) => setEntry({ ...entry, [key]: e.target.value })}
              />
            </label>
          ))}
          <label className="staff-field">
            {t.catalogueFields.results}
            <textarea
              dir="auto"
              rows={4}
              value={entry.fields}
              onChange={(e) => setEntry({ ...entry, fields: e.target.value })}
            />
          </label>
        </div>
      )}
      {(action === "approve" || action === "retire") && catalogue && (
        <ul className="booking-list">
          {catalogue
            .filter((c) => c.active && (action === "retire" || !c.approval))
            .map((c) => (
              <li key={c._id} className="assistant-chosen">
                <p>
                  <bdi>{c.name}</bdi> · <bdi>{c.specimen}</bdi>
                  <br />
                  <bdi>
                    {c.fields
                      .map((f) => `${f.name} (${f.unit}) ${f.reference}`)
                      .join("; ")}
                  </bdi>
                </p>
                <button
                  type="button"
                  className="staff-button"
                  onClick={() => setTarget(c)}
                >
                  {t.select}
                </button>
              </li>
            ))}
        </ul>
      )}
      {action === "approve" && target && (
        <label className="staff-field">
          {t.evidence}
          <input
            dir="auto"
            maxLength={250}
            value={evidence}
            onChange={(e) => setEvidence(e.target.value)}
          />
        </label>
      )}
      {task.busy && <LoadingStatus label="Checking…" />}
      {task.error && (
        <p className="staff-error" role="alert">
          {task.error}
        </p>
      )}
      {action === "add" && complete && (
        <div className="staff-action-confirmation">
          <p>
            <bdi>
              {entry.name} · {entry.specimen} ·{" "}
              {fields.map((f) => f.name).join(", ")}
            </bdi>
          </p>
          <p>{t.needsApproval}</p>
          <button
            type="button"
            className="staff-button staff-button-primary"
            disabled={task.busy}
            onClick={() =>
              change(
                {
                  action: "save",
                  name: entry.name,
                  specimen: entry.specimen,
                  group: entry.group,
                  fields,
                },
                t.testAdded(entry.name),
              )
            }
          >
            {t.catalogueActions.add}
          </button>
        </div>
      )}
      {target && (action === "retire" || evidence.trim()) && (
        <div className="staff-action-confirmation">
          <p>
            <bdi>{target.name}</bdi>
          </p>
          <button
            type="button"
            className="staff-button staff-button-primary"
            disabled={task.busy}
            onClick={() =>
              change(
                {
                  action,
                  id: target._id,
                  revision: target.revision,
                  ...(action === "approve" ? { reason: evidence.trim() } : {}),
                },
                action === "approve"
                  ? t.testApproved(target.name)
                  : t.testRetired(target.name),
              )
            }
          >
            {t.catalogueActions[action]}
          </button>
        </div>
      )}
    </div>
  );
}
