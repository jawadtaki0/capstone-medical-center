import { useEffect, useRef, useState } from "react";
import AssistantPatient from "./AssistantPatient.jsx";
import AssistantLab from "./AssistantLab.jsx";
import LoadingStatus from "../../../../shared/ui/LoadingStatus.jsx";
import {
  namedTests,
  typedValues,
  createPrepareRun,
} from "../lib/assistantPrepare.js";
import { useTask } from "./useTask.js";
import { TEXT } from "./assistantText.js";
import "./patients.css";

// Lab Admin: order, collection, results and draft PDF from one confirmation.
// Review, finalizing and release stay separate decisions.
export default function AssistantPrepare(props) {
  const { api, language, prefill, question, onError, onDone } = props;
  const t = TEXT[language],
    run = useRef(null);
  const task = useTask(onError);
  const [catalogue, setCatalogue] = useState(null),
    [patient, setPatient] = useState(null),
    [tests, setTests] = useState([]),
    [values, setValues] = useState({}),
    [collected, setCollected] = useState(false),
    [order, setOrder] = useState(null),
    [draft, setDraft] = useState(false),
    [saved, setSaved] = useState(false),
    [reviewed, setReviewed] = useState(false),
    [finalized, setFinalized] = useState(false),
    [releasing, setReleasing] = useState(false);

  useEffect(() => {
    task
      .run(() => api.lab({ action: "list" }))
      .then((result) => {
        if (!result) return;
        const active = result.catalogue.filter(
          (test) => test.active && test.approval,
        );
        setCatalogue(active);
        setTests(namedTests(question, active));
        setValues(
          Object.fromEntries(
            active.map((test) => [
              test._id,
              typedValues(question, test.fields),
            ]),
          ),
        );
      });
  }, []);

  // A different patient, test or value is a different confirmation.
  function changed(apply) {
    if (!order) run.current = null;
    apply();
  }
  async function prepare() {
    run.current ??= createPrepareRun({
      api,
      patient,
      testIds: tests,
      values,
    });
    const result = await task.run(
      () => run.current.prepare(),
      (error) => error.order && setOrder(error.order),
    );
    if (!result) return;
    setOrder(result.order);
    setDraft(true);
    setSaved(Boolean(result.fileSaved));
  }
  async function download() {
    const result = await task.run(() =>
      api.lab({
        action: "read-report",
        id: order._id,
        revision: order.revision,
        reportId: order.reportPreview.id,
      }),
    );
    if (result?.fileSaved) setSaved(true);
  }
  async function finalize() {
    const result = await task.run(() =>
      api.lab({
        action: "finalize-report",
        id: order._id,
        revision: order.revision,
        reportId: order.reportPreview.id,
      }),
    );
    if (!result) return;
    setOrder(result);
    setFinalized(true);
    onDone(t.finalized("LAB-" + result._id));
  }

  if (releasing)
    return (
      <AssistantLab
        {...props}
        type="release"
        prefill={{ orderNumber: "LAB-" + order._id }}
      />
    );
  const chosen = (catalogue ?? []).filter((test) => tests.includes(test._id));
  const complete =
    patient &&
    chosen.length > 0 &&
    collected &&
    chosen.every((test) =>
      test.fields.every((_, i) => values[test._id]?.[i]?.trim()),
    );
  if (finalized)
    return (
      <div className="assistant-task">
        <p role="status" className="staff-notice">
          {t.finalized("LAB-" + order._id)}
        </p>
        <button
          type="button"
          className="staff-button staff-button-primary"
          onClick={() => setReleasing(true)}
        >
          {t.releaseNow}
        </button>
      </div>
    );
  return (
    <div className="assistant-task">
      {!draft && (
        <>
          {patient ? (
            <div className="assistant-chosen">
              <p>
                <strong>{t.patient}: </strong>
                <bdi>
                  {patient.firstName} {patient.fatherName} {patient.lastName}
                </bdi>{" "}
                · <bdi>{patient.patientNumber}</bdi>
              </p>
              <button
                type="button"
                className="staff-button"
                disabled={task.busy || Boolean(order)}
                onClick={() => changed(() => setPatient(null))}
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
              onPick={(p) => changed(() => setPatient(p))}
            />
          )}
          {catalogue && (
            <fieldset
              className="staff-fieldset"
              disabled={task.busy || Boolean(order)}
            >
              <legend>{t.tests}</legend>
              <div className="staff-checkboxes">
                {catalogue.map((test) => (
                  <label key={test._id}>
                    <input
                      type="checkbox"
                      checked={tests.includes(test._id)}
                      onChange={(e) =>
                        changed(() =>
                          setTests(
                            e.target.checked
                              ? [...tests, test._id]
                              : tests.filter((v) => v !== test._id),
                          ),
                        )
                      }
                    />
                    <bdi>{test.name}</bdi>
                  </label>
                ))}
              </div>
              {!catalogue.length && <p role="status">{t.noTests}</p>}
            </fieldset>
          )}
          {chosen.map((test) => (
            <fieldset
              className="staff-fieldset"
              key={test._id}
              disabled={task.busy}
            >
              <legend>
                <bdi>{test.name}</bdi> · {t.values}
              </legend>
              <div className="staff-form-grid">
                {test.fields.map((field, i) => (
                  <label className="staff-field" key={field.name}>
                    <bdi>
                      {field.name} ({field.unit}) · {field.reference}
                    </bdi>
                    <input
                      dir="ltr"
                      maxLength={250}
                      value={values[test._id]?.[i] ?? ""}
                      onChange={(e) =>
                        changed(() =>
                          setValues({
                            ...values,
                            [test._id]: test.fields.map((_, n) =>
                              n === i
                                ? e.target.value
                                : (values[test._id]?.[n] ?? ""),
                            ),
                          }),
                        )
                      }
                    />
                  </label>
                ))}
              </div>
            </fieldset>
          ))}
          {chosen.length > 0 && (
            <label className="staff-confirm">
              <input
                type="checkbox"
                checked={collected}
                onChange={(e) => setCollected(e.target.checked)}
              />
              {t.allCollected}
            </label>
          )}
        </>
      )}
      {order && !draft && (
        <p className="staff-error" role="alert">
          {t.kept("LAB-" + order._id, t.status[order.status] ?? order.status)}
        </p>
      )}
      {task.busy && <LoadingStatus label="Checking…" />}
      {task.error && (
        <p className="staff-error" role="alert">
          {task.error}
        </p>
      )}
      {!draft && complete && (
        <div className="staff-action-confirmation">
          <p>
            <bdi>
              {patient.firstName} {patient.lastName}
            </bdi>{" "}
            · <bdi>{patient.patientNumber}</bdi>
          </p>
          {chosen.map((test) => (
            <p key={test._id}>
              <bdi>
                {test.name}:{" "}
                {test.fields
                  .map((field, i) => `${field.name} ${values[test._id][i]}`)
                  .join(", ")}
              </bdi>
            </p>
          ))}
          <p>{t.prepareHint}</p>
          <button
            type="button"
            className="staff-button staff-button-primary"
            disabled={task.busy}
            onClick={prepare}
          >
            {t.prepare}
          </button>
        </div>
      )}
      {draft && (
        <div className="staff-action-confirmation">
          <p role="status">{t.drafted("LAB-" + order._id)}</p>
          {!saved && <p>{t.noSave}</p>}
          <button
            type="button"
            className="staff-button"
            disabled={task.busy}
            onClick={download}
          >
            {t.previewAgain}
          </button>
          <label className="staff-confirm">
            <input
              type="checkbox"
              checked={reviewed}
              disabled={!saved}
              onChange={(e) => setReviewed(e.target.checked)}
            />
            {t.reviewed}
          </label>
          <button
            type="button"
            className="staff-button staff-button-primary"
            disabled={task.busy || !saved || !reviewed}
            onClick={finalize}
          >
            {t.finalize}
          </button>
        </div>
      )}
    </div>
  );
}
