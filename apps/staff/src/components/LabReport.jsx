import { useState } from "react";

const button = "staff-button";
const primary = button + " staff-button-primary";

function Fields({ fields, values, onChange, prefix }) {
  return (
    <table className="lab-ordered-tests">
      <thead>
        <tr>
          <th>Field</th>
          <th>Result</th>
          <th>Unit</th>
          <th>Reference interval</th>
        </tr>
      </thead>
      <tbody>
        {fields.map((field, index) => (
          <tr key={index}>
            <th scope="row">{field.name}</th>
            <td>
              {onChange ? (
                <input
                  aria-label={`${prefix}: ${field.name} (${index + 1})`}
                  value={values[index] ?? ""}
                  maxLength={250}
                  required
                  onChange={(event) => onChange(index, event.target.value)}
                />
              ) : (
                values[index] || "—"
              )}
            </td>
            <td>{field.unit}</td>
            <td>{field.reference}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ResultTest({ test, newer, change }) {
  const [values, setValues] = useState(
    test.fields.map((_, i) => test.results?.[i] ?? ""),
  );
  const [reason, setReason] = useState("");
  const [reviewed, setReviewed] = useState(false);
  return (
    <section className="lab-result-test">
      <h3>{test.name}</h3>
      {test.cancelled ? (
        <p>Cancelled</p>
      ) : (
        <>
          <p>Approved template version {test.revision}</p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              change("results", { target: test._id, results: values });
            }}
          >
            <Fields
              fields={test.fields}
              values={values}
              prefix={test.name}
              onChange={(index, value) =>
                setValues((current) =>
                  current.map((old, i) => (i === index ? value : old)),
                )
              }
            />
            <button className={button}>Save results: {test.name}</button>
          </form>
          {newer && (
            <details>
              <summary>Review newer approved template</summary>
              <h4>Saved results and current fields</h4>
              <Fields fields={test.fields} values={test.results ?? []} />
              <h4>New fields and units · Version {newer.revision}</h4>
              <Fields fields={newer.fields} values={[]} />
              <p className="staff-warning">
                Switching archives the current template and saved results.
                Re-enter results using the newly approved fields and units.
              </p>
              <label>
                Template change reason{" "}
                <input
                  value={reason}
                  maxLength={250}
                  onChange={(event) => setReason(event.target.value)}
                />
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={reviewed}
                  onChange={(event) => setReviewed(event.target.checked)}
                />{" "}
                I reviewed the saved results, fields and units and confirmed the
                new template matches the method used.
              </label>
              <button
                className={button}
                disabled={!reason.trim() || !reviewed}
                onClick={() =>
                  change("switch-template", {
                    target: test._id,
                    templateRevision: newer.revision,
                    reason,
                    reviewed,
                  })
                }
              >
                Switch approved template
              </button>
            </details>
          )}
        </>
      )}
    </section>
  );
}

export default function LabReport({ order, catalogue, roles, change }) {
  const lab = roles.includes("Lab Admin");
  const manage = lab || roles.includes("Admin");
  const reception = roles.includes("Receptionist");
  const [reason, setReason] = useState("");
  const [patientNumber, setPatientNumber] = useState("");
  const [orderNumber, setOrderNumber] = useState("");
  const active = order.tests.filter((test) => !test.cancelled);
  const canPreview =
    active.length > 0 &&
    active.every((test) => test.results?.length === test.fields.length);
  const draft =
    order.reportPreview?.revision === order.revision
      ? order.reportPreview
      : null;
  const versions = order.reportVersions ?? [];
  const current = versions.at(-1);
  const ready = order.status === "Ready to release";
  const released = order.status === "Released";
  const editing = lab && order.status === "Sample collected";
  const identity = { reportId: current?.id };
  return (
    <>
      {editing && (
        <section className="lab-card">
          <h2>Results</h2>
          {order.tests.map((test) => (
            <ResultTest
              key={test._id + ":" + test.revision}
              test={test}
              change={change}
              newer={catalogue.find(
                (item) =>
                  item._id === test._id &&
                  item.active &&
                  item.approval &&
                  item.revision > test.revision &&
                  item.specimen === test.specimen &&
                  item.group === test.group,
              )}
            />
          ))}
          {!canPreview && (
            <p>
              Save results for each non-cancelled test to preview the report.
            </p>
          )}
          <button
            className={button}
            disabled={!canPreview}
            onClick={() => change("preview-report")}
          >
            Preview report PDF
          </button>
          {draft && (
            <>
              <p>
                Review the preview PDF before finalizing version {draft.version}
                {draft.corrected ? " (Corrected report)" : ""}.
              </p>
              <button
                className={button}
                onClick={() => change("read-report", { reportId: draft.id })}
              >
                Download preview again
              </button>
              <button
                className={primary}
                onClick={() =>
                  change("finalize-report", { reportId: draft.id })
                }
              >
                Finalize report
              </button>
            </>
          )}
        </section>
      )}
      {(ready || released || versions.length > 0) && (
        <section className="lab-card">
          <h2>Report and release</h2>
          {(ready || released) && current && (
            <>
              <p>
                {current.corrected ? "Corrected report · " : ""}Version{" "}
                {current.version} · {current.status}
              </p>
              <button
                className={button}
                onClick={() => change("read-report", identity)}
              >
                Download current PDF
              </button>
            </>
          )}
          {ready && (reception || manage) && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                change("release-report", {
                  ...identity,
                  patientNumber: patientNumber.trim(),
                  orderNumber: orderNumber.trim(),
                });
              }}
            >
              <p>
                Compare the patient number and order ID with the finalized PDF
                before release.
              </p>
              <label>
                Confirm patient number{" "}
                <input
                  value={patientNumber}
                  onChange={(event) => setPatientNumber(event.target.value)}
                  required
                />
              </label>
              <label>
                Confirm order ID{" "}
                <input
                  value={orderNumber}
                  onChange={(event) => setOrderNumber(event.target.value)}
                  required
                />
              </label>
              <button className={primary}>Release report</button>
            </form>
          )}
          {released && reception && current?.websitePublication && (
            <button
              className={button}
              onClick={() => change("publish-release")}
            >
              Retry website publication
            </button>
          )}
          {((ready && lab) || (released && manage)) && (
            <>
              <label>
                Report action reason{" "}
                <input
                  value={reason}
                  maxLength={250}
                  onChange={(event) => setReason(event.target.value)}
                />
              </label>
              <button
                className={button}
                disabled={!reason.trim()}
                onClick={() =>
                  change(ready ? "reopen-report" : "withdraw-report", {
                    ...identity,
                    reason,
                  })
                }
              >
                {ready ? "Reopen report" : "Withdraw report"}
              </button>
            </>
          )}
          <details>
            <summary>Report version history</summary>
            <ol>
              {versions.map((version) => (
                <li key={version.id}>
                  Version {version.version}
                  {version.corrected ? " · Corrected report" : ""} ·{" "}
                  {version.status}
                  {version.reason && " · " + version.reason}
                </li>
              ))}
            </ol>
          </details>
        </section>
      )}
    </>
  );
}
