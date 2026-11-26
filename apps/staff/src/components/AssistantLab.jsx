import { useEffect, useState } from "react";
import AssistantPatient from "./AssistantPatient.jsx";
import LoadingStatus from "../../../../shared/ui/LoadingStatus.jsx";
import {
  eligibleOrders,
  releasableReport,
  requiredSpecimens,
  collectOrder,
  releaseRequest,
} from "../lib/assistantLab.js";
import { useTask } from "./useTask.js";
import { TEXT } from "./assistantText.js";
import "./bookings.css";
import "./patients.css";

const matches = (order, query) => {
  const values = [
    order.patientName,
    order.patientNumber,
    "LAB-" + order._id,
  ].map((v) => v.toLowerCase());
  return query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .every((word) => values.some((value) => value.includes(word)));
};

// Lab changes go through the Lab endpoints with one confirmation each. PDFs are
// still prepared on the Lab screen.
export default function AssistantLab({
  api,
  type,
  language,
  prefill,
  roles,
  onError,
  onDone,
}) {
  const t = TEXT[language];
  const task = useTask(onError);
  const creating = type === "labCreate";
  const [data, setData] = useState(null),
    [query, setQuery] = useState(
      prefill.orderNumber ??
        prefill.patientNumber ??
        [prefill.firstName, prefill.lastName].filter(Boolean).join(" "),
    ),
    [patient, setPatient] = useState(null),
    [tests, setTests] = useState([]),
    [order, setOrder] = useState(null),
    [checked, setChecked] = useState([]),
    [reason, setReason] = useState(""),
    [specimen, setSpecimen] = useState(""),
    [previewed, setPreviewed] = useState(null),
    [typed, setTyped] = useState({ patientNumber: "", orderNumber: "" }),
    [done, setDone] = useState("");

  async function load() {
    const result = await task.run(() => api.lab({ action: "list" }));
    if (result) setData(result);
  }
  useEffect(() => {
    load();
  }, []);

  function choose(next) {
    setOrder(next);
    setChecked([]);
    setPreviewed(null);
    setTyped({ patientNumber: "", orderNumber: "" });
    setReason("");
    setSpecimen("");
  }
  // A refused change means the record moved on: show the current one again.
  async function change(action, message) {
    const result = await task.run(action, (error) => {
      if (type === "release" && error.message.startsWith("Confirm the exact"))
        return;
      choose(null);
      api.lab({ action: "list" }).then(setData, () => {});
    });
    if (result) {
      const text = message(result);
      setDone(text);
      onDone(text);
    }
  }
  async function preview(report) {
    const result = await task.run(() =>
      api.lab({
        action: "read-report",
        id: order._id,
        revision: order.revision,
        reportId: report.id,
      }),
    );
    if (result?.fileSaved) setPreviewed(report.id);
  }

  if (done)
    return (
      <div role="status" className="staff-notice assistant-done">
        <p>
          <strong>{done}</strong>
        </p>
        {type === "release" && <p>{t.delivery}</p>}
      </div>
    );

  const heading = (o) => (
    <>
      <bdi>{o.patientName}</bdi> · <bdi>{o.patientNumber}</bdi> ·{" "}
      <bdi>LAB-{o._id}</bdi> · <bdi>{t.status[o.status] ?? o.status}</bdi>
    </>
  );
  const testNames = (o) =>
    o.tests
      .filter((test) => !test.cancelled)
      .map((test) => test.name)
      .join(", ");
  const found = data
    ? eligibleOrders(data.orders, type, roles).filter(
        (o) => !query.trim() || matches(o, query),
      )
    : [];
  const available =
    data?.catalogue.filter((test) => test.active && test.approval) ?? [];
  const report = order && releasableReport(order);
  const correcting = ["recollect", "reopen", "withdraw"].includes(type);

  return (
    <div className="assistant-task">
      {creating &&
        (patient ? (
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
              disabled={task.busy}
              onClick={() => setPatient(null)}
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
            onPick={setPatient}
          />
        ))}
      {creating && data && (
        <fieldset className="staff-fieldset" disabled={task.busy}>
          <legend>{t.tests}</legend>
          <div className="staff-checkboxes">
            {available.map((test) => (
              <label key={test._id}>
                <input
                  type="checkbox"
                  checked={tests.includes(test._id)}
                  onChange={(e) =>
                    setTests(
                      e.target.checked
                        ? [...tests, test._id]
                        : tests.filter((value) => value !== test._id),
                    )
                  }
                />
                <bdi>{test.name}</bdi>
              </label>
            ))}
          </div>
          {!available.length && <p role="status">{t.noTests}</p>}
        </fieldset>
      )}

      {!creating && !order && data && (
        <>
          <label className="staff-field">
            {t.findOrder}
            <input
              dir="auto"
              maxLength={80}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <p role="status">{found.length ? t.pickOrder : t.noOrder}</p>
          <ul className="booking-list">
            {found.slice(0, 10).map((o) => (
              <li key={o._id}>
                <p>{heading(o)}</p>
                <p>
                  <bdi>{testNames(o)}</bdi>
                </p>
                <button
                  type="button"
                  className="staff-button"
                  disabled={task.busy}
                  onClick={() => choose(o)}
                >
                  {t.select}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {order && (
        <div className="assistant-chosen">
          <p>{heading(order)}</p>
          <button
            type="button"
            className="staff-button"
            disabled={task.busy}
            onClick={() => choose(null)}
          >
            {t.change}
          </button>
        </div>
      )}
      {order && type === "collect" && (
        <fieldset className="staff-fieldset" disabled={task.busy}>
          <legend>{t.specimens}</legend>
          <div className="staff-checkboxes">
            {requiredSpecimens(order).map((row) => (
              <label key={row.id}>
                <input
                  type="checkbox"
                  checked={checked.includes(row.id)}
                  onChange={(e) =>
                    setChecked(
                      e.target.checked
                        ? [...checked, row.id]
                        : checked.filter((value) => value !== row.id),
                    )
                  }
                />
                <bdi>
                  {row.kind} —{" "}
                  {order.tests
                    .filter(
                      (test) =>
                        row.testIds.includes(test._id) && !test.cancelled,
                    )
                    .map((test) => test.name)
                    .join(", ")}
                </bdi>
              </label>
            ))}
          </div>
        </fieldset>
      )}
      {order && type === "recollect" && (
        <label className="staff-field">
          {t.specimen}
          <select
            value={specimen}
            onChange={(e) => setSpecimen(e.target.value)}
          >
            <option value="" disabled>
              {t.choose}
            </option>
            {requiredSpecimens(order).map((row) => (
              <option key={row.id} value={row.id}>
                {row.kind}
              </option>
            ))}
          </select>
        </label>
      )}
      {order && correcting && (
        <label className="staff-field">
          {t.internalReason}
          <input
            dir="auto"
            maxLength={250}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
      )}
      {order && type === "labCancel" && (
        <label className="staff-field">
          {t.internalReason}
          <input
            dir="auto"
            maxLength={250}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
      )}

      {task.busy && <LoadingStatus label="Checking…" />}
      {task.error && (
        <p className="staff-error" role="alert">
          {task.error}
        </p>
      )}

      {creating && patient && tests.length > 0 && (
        <div className="staff-action-confirmation">
          <p>
            <bdi>
              {patient.firstName} {patient.lastName}
            </bdi>{" "}
            · <bdi>{patient.patientNumber}</bdi>
          </p>
          <p>
            <bdi>
              {available
                .filter((test) => tests.includes(test._id))
                .map((test) => test.name)
                .join(", ")}
            </bdi>
          </p>
          <p>{t.nothingYet}</p>
          <button
            type="button"
            className="staff-button staff-button-primary"
            disabled={task.busy}
            onClick={() =>
              change(
                () =>
                  api.lab({
                    action: "create",
                    patientId: patient.id,
                    patientRevision: patient.revision,
                    testIds: tests,
                  }),
                (result) => t.orderCreated("LAB-" + result._id),
              )
            }
          >
            {t.confirmOrder}
          </button>
        </div>
      )}
      {order &&
        type === "collect" &&
        requiredSpecimens(order).every((row) => checked.includes(row.id)) && (
          <div className="staff-action-confirmation">
            <p>{heading(order)}</p>
            <p>{t.nothingYet}</p>
            <button
              type="button"
              className="staff-button staff-button-primary"
              disabled={task.busy}
              onClick={() =>
                change(
                  () => collectOrder(api, order),
                  () => t.collected("LAB-" + order._id),
                )
              }
            >
              {t.confirmCollect}
            </button>
          </div>
        )}
      {order &&
        correcting &&
        reason.trim() &&
        (type !== "recollect" || specimen) && (
          <div className="staff-action-confirmation">
            <p>{heading(order)}</p>
            <p>{t.correctionHint[type]}</p>
            <button
              type="button"
              className="staff-button staff-button-primary"
              disabled={task.busy}
              onClick={() =>
                change(
                  () =>
                    api.lab({
                      action:
                        type === "recollect" ? "recollect" : `${type}-report`,
                      id: order._id,
                      revision: order.revision,
                      reason: reason.trim(),
                      ...(type === "recollect"
                        ? { target: specimen }
                        : { reportId: order.reportVersions.at(-1).id }),
                    }),
                  () => t.corrected[type]("LAB-" + order._id),
                )
              }
            >
              {t.confirmCorrection[type]}
            </button>
          </div>
        )}
      {order && type === "labCancel" && reason.trim() && (
        <div className="staff-action-confirmation">
          <p>{heading(order)}</p>
          <p>
            <bdi>{testNames(order)}</bdi>
          </p>
          <p>{t.nothingYet}</p>
          <button
            type="button"
            className="staff-button staff-button-primary"
            disabled={task.busy}
            onClick={() =>
              change(
                () =>
                  api.lab({
                    action: "cancel",
                    id: order._id,
                    revision: order.revision,
                    reason: reason.trim(),
                  }),
                () => t.orderCancelled("LAB-" + order._id),
              )
            }
          >
            {t.confirmCancelOrder}
          </button>
        </div>
      )}
      {report && type === "release" && (
        <div className="staff-action-confirmation">
          <p>{heading(order)}</p>
          <p>
            <bdi>{testNames(order)}</bdi>
          </p>
          <p>{t.version(report.version, report.corrected)}</p>
          <button
            type="button"
            className="staff-button"
            disabled={task.busy}
            onClick={() => preview(report)}
          >
            {t.preview}
          </button>
          <p>{previewed === report.id ? t.compare : t.previewFirst}</p>
          {["patientNumber", "orderNumber"].map((key) => (
            <label className="staff-field" key={key}>
              {t.retype[key]}
              <input
                dir="ltr"
                autoComplete="off"
                maxLength={60}
                value={typed[key]}
                onChange={(e) => setTyped({ ...typed, [key]: e.target.value })}
              />
            </label>
          ))}
          <button
            type="button"
            className="staff-button staff-button-primary"
            disabled={
              task.busy ||
              previewed !== report.id ||
              !typed.patientNumber.trim() ||
              !typed.orderNumber.trim()
            }
            onClick={() =>
              change(
                () => api.lab(releaseRequest(order, typed)),
                () => t.released("LAB-" + order._id, report.version),
              )
            }
          >
            {t.confirmRelease}
          </button>
        </div>
      )}
    </div>
  );
}
