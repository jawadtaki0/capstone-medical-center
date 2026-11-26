import { useEffect, useState } from "react";
import PatientEditor from "./PatientEditor.jsx";
import LabReport from "./LabReport.jsx";
import LabWhatsApp from "./LabWhatsApp.jsx";
import PhoneInput from "./PhoneInput.jsx";
import { patientAgeLabel, patientToday } from "../../shared/patient-input.js";
import { hasLabCollection } from "../../shared/lab-collection.js";
import "./lab.css";

const empty = { name: "", specimen: "", group: "", template: "" };
const templateHint =
  "Use one result per line: name | unit | reference interval.";
const steps = [
  "Registered",
  "Sample collected",
  "Ready to release",
  "Released",
];
const personName = (p) => [p.firstName, p.lastName].join(" ");

export default function LabPanel({ api, roles, onError }) {
  const lab = roles.includes("Admin") || roles.includes("Lab Admin");
  const reception = roles.includes("Receptionist");
  const [data, setData] = useState({ catalogue: [], orders: [] });
  const [view, setView] = useState("worklist");
  const [query, setQuery] = useState("");
  const [testQuery, setTestQuery] = useState("");
  const [allDates, setAllDates] = useState(false);
  const [searched, setSearched] = useState(false);
  const [selected, select] = useState("");
  const [draft, setDraft] = useState(empty);
  const [patient, setPatient] = useState(null);
  const [matches, setMatches] = useState([]);
  const [editor, setEditor] = useState(false);
  const [number, setNumber] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [patientPhone, setPatientPhone] = useState("");
  const [numberError, setNumberError] = useState("");
  const [tests, setTests] = useState([]);
  const [reason, setReason] = useState("");
  const [approval, setApproval] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [whatsAppDraft, setWhatsAppDraft] = useState(null);
  const [templateError, setTemplateError] = useState("");
  const order = data.orders.find((item) => item._id === selected);
  const orderPatientId = order?.patientId;
  const [orderPatient, setOrderPatient] = useState(null);
  useEffect(() => {
    if (!orderPatientId) return;
    let current = true;
    api.readPatient({ patientId: orderPatientId }).then(
      ({ patient: record }) => { if (current) setOrderPatient(record); },
      () => {},
    );
    return () => { current = false; };
  }, [api, orderPatientId]);
  const registered = order?.status === "Registered";
  const collected = order?.status === "Sample collected";
  const canCancel =
    order &&
    ((lab && (registered || collected)) ||
      (reception && registered && !hasLabCollection(order)));
  const activeTests = data.catalogue.filter(
    (test) => test.active && test.approval,
  );
  const today = patientToday();
  const visibleOrders = data.orders.filter(
    (item) =>
      (allDates || patientToday(new Date(item.createdAt)) === today) &&
      [
        item.patientName,
        item.patientNumber,
        "LAB-" + item._id,
        item.status,
      ].some((value) =>
        value.toLowerCase().includes(query.trim().toLowerCase()),
      ),
  );
  const required =
    order?.specimens.filter((row) =>
      row.testIds.some((id) =>
        order.tests.some((test) => test._id === id && !test.cancelled),
      ),
    ) ?? [];
  async function run(task) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await task();
    } catch (err) {
      setError(err.message);
      try {
        await reload();
      } catch {
        // Keep the original error while the connection is unavailable.
      }
    } finally {
      setBusy(false);
    }
  }
  async function reload() {
    setData(await api.lab({ action: "list" }));
  }
  useEffect(() => {
    void run(reload);
  }, [api]);
  function change(action, extra = {}) {
    return run(async () => {
      const result = await api.lab({
        action,
        id: order._id,
        revision: order.revision,
        reason,
        ...extra,
      });
      if (result.fileError) setError(result.fileError);
      if (result.fileSaved) setNotice("PDF saved.");
      if (action === "open-notice") setWhatsAppDraft(result);
      else setWhatsAppDraft(null);
      if (action === "read-report") return;
      const next = result.order ?? result;
      setData((current) => ({
        ...current,
        orders: current.orders.map((item) =>
          item._id === next._id ? next : item,
        ),
      }));
      setReason("");
    });
  }
  function save(action, entry, extra = {}) {
    return run(async () => {
      await api.lab({
        action,
        id: entry._id,
        revision: entry.revision,
        ...extra,
      });
      setDraft(empty);
      setApproval("");
      await reload();
    });
  }
  function usePatient(person) {
    setPatient(person);
    setEditor(false);
  }
  return (
    <section className="lab-workspace">
      {error && (
        <p className="staff-error" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <fieldset disabled={busy}>
        {view !== "worklist" && (
          <button
            className="staff-button staff-button-link"
            onClick={() => {
              setView("worklist");
              setReason("");
            }}
          >
            Back to orders
          </button>
        )}
        {view === "worklist" && (
          <section className="lab-card">
            <header className="lab-toolbar">
              <div>
                <h1>{allDates ? "Recent orders" : "Today’s orders"}</h1>
                {!allDates && (
                  <time dateTime={today}>
                    {new Date().toLocaleDateString(undefined, {
                      weekday: "short",
                      month: "short",
                      day: "numeric",
                      timeZone: "Asia/Beirut",
                    })}
                  </time>
                )}
              </div>
              <div>
                {lab && (
                  <button
                    className="staff-button"
                    onClick={() => setView("catalogue")}
                  >
                    Catalogue
                  </button>
                )}
                {(reception || lab) && (
                  <button
                    className="staff-button staff-button-primary"
                    onClick={() => {
                      setPatient(null);
                      setNumber("");
                      setFirstName("");
                      setLastName("");
                      setPatientPhone("");
                      setNumberError("");
                      setMatches([]);
                      setSearched(false);
                      setTests([]);
                      setTestQuery("");
                      setView("new");
                    }}
                  >
                    New order
                  </button>
                )}
              </div>
            </header>
            <label>
              Search orders{" "}
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Patient name, patient number, or order ID"
              />
            </label>
            <div className="lab-toolbar">
              <label>
                <input
                  type="checkbox"
                  checked={allDates}
                  onChange={(event) => setAllDates(event.target.checked)}
                />{" "}
                Include earlier orders
              </label>
              <button className="staff-button" onClick={() => run(reload)}>
                Refresh orders
              </button>
            </div>
            <div className="lab-table">
              <table>
                <thead>
                  <tr>
                    <th>Order ID</th>
                    <th>Patient</th>
                    <th>Tests</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleOrders.map((item) => (
                    <tr key={item._id}>
                      <td>
                        <button
                          className="staff-button staff-button-link"
                          onClick={() => {
                            select(item._id);
                            setReason("");
                            setView("specimens");
                          }}
                        >
                          LAB-{item._id}
                        </button>
                      </td>
                      <td>
                        {item.patientName}
                        <br />
                        {item.patientNumber}
                      </td>
                      <td>{item.tests.map((test) => test.name).join(", ")}</td>
                      <td>
                        <span className="lab-status" data-status={item.status}>
                          {item.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!visibleOrders.length && <p role="status">No matching orders.</p>}
          </section>
        )}
        {view === "specimens" && order && (
          <>
            <header className="lab-card">
              <h1>Specimen collection</h1>
              <p>LAB-{order._id}</p>
              <p>
                {order.patientName} · {order.patientNumber}
              </p>
              {orderPatient?.id === orderPatientId && (
                <p>Age: {patientAgeLabel(orderPatient.dateOfBirth)}</p>
              )}
              <p>Ordered {new Date(order.createdAt).toLocaleString()}</p>
              <ol className="lab-timeline">
                {steps.map((step, index) => (
                  <li
                    className={
                      index <= steps.indexOf(order.status) ? "lab-current" : ""
                    }
                    key={step}
                    aria-current={step === order.status ? "step" : undefined}
                  >
                    {step}
                  </li>
                ))}
              </ol>
              {order.status === "Cancelled" && <strong>Cancelled</strong>}
            </header>
            <div>
              <section className="lab-card">
                <h3>Specimens</h3>
                {required.map((row) => (
                  <div key={row.id}>
                    <label>
                      <input
                        type="checkbox"
                        checked={row.checked}
                        disabled={!registered || !(lab || reception)}
                        onChange={(event) =>
                          change("check", {
                            target: row.id,
                            checked: event.target.checked,
                          })
                        }
                      />{" "}
                      {row.kind}
                    </label>
                    <p>
                      {order.tests
                        .filter(
                          (test) =>
                            row.testIds.includes(test._id) && !test.cancelled,
                        )
                        .map((test) => test.name)
                        .join(", ")}
                    </p>
                  </div>
                ))}
                {registered && (lab || reception) && (
                  <button
                    className="staff-button staff-button-primary"
                    disabled={
                      !required.length || required.some((row) => !row.checked)
                    }
                    onClick={() => change("collect")}
                  >
                    Mark collected
                  </button>
                )}
              </section>
              <details className="lab-card" key={order._id}>
                <summary>Order details and actions</summary>
                <h3>Ordered tests</h3>
                <table className="lab-ordered-tests">
                  <thead>
                    <tr>
                      <th>Test</th>
                      <th>Specimen</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {order.tests.map((test) => (
                      <tr key={test._id}>
                        <td>{test.name}</td>
                        <td>{test.specimen}</td>
                        <td>
                          {test.cancelled ? (
                            "Cancelled"
                          ) : lab && (registered || collected) ? (
                            <button
                              className="staff-button"
                              disabled={!reason.trim()}
                              onClick={() =>
                                change("cancel-test", { target: test._id })
                              }
                            >
                              Cancel test
                            </button>
                          ) : (
                            "Ordered"
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <h3>Order actions</h3>
                {canCancel && (
                  <>
                    <label>
                      Reason{" "}
                      <input
                        value={reason}
                        onChange={(event) => setReason(event.target.value)}
                        maxLength={250}
                      />
                    </label>
                    <button
                      className="staff-button"
                      disabled={!reason.trim()}
                      onClick={() => change("cancel")}
                    >
                      Cancel order
                    </button>
                    {lab &&
                      collected &&
                      required.map((row) => (
                        <button
                          className="staff-button"
                          key={row.id}
                          disabled={!reason.trim()}
                          onClick={() =>
                            change("recollect", { target: row.id })
                          }
                        >
                          Require recollection: {row.kind}
                        </button>
                      ))}
                  </>
                )}
                <h4>History</h4>
                <ol>
                  {order.history.map((item, index) => (
                    <li key={index}>
                      {new Date(item.at).toLocaleString()} ·{" "}
                      {
                        {
                          check: "Specimen check",
                          collect: "Sample collected",
                          cancel: "Order cancelled",
                          "cancel-test": "Test cancelled",
                          recollect: "Recollection required",
                        }[item.action]
                      }
                      {item.reason && " · " + item.reason}
                    </li>
                  ))}
                </ol>
              </details>
            </div>
            <LabReport
              key={order._id + order.status}
              order={order}
              catalogue={data.catalogue}
              roles={roles}
              change={change}
            />
            {(reception || lab) && (
              <LabWhatsApp
                key={order._id + ":" + order.status}
                api={api}
                order={order}
                change={change}
                draft={whatsAppDraft}
              />
            )}
          </>
        )}
        {view === "new" && (reception || lab) && (
          <section className="lab-card">
            <h1>New order</h1>
            <h2>Patient</h2>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const value = number.trim();
                if (value && !/^(?:P-)?\d{1,16}$/i.test(value)) {
                  setNumberError(
                    "Enter the patient number, for example P-00000001.",
                  );
                  return;
                }
                const criteria = Object.fromEntries(
                  Object.entries({
                    patientNumber:
                      value &&
                      "P-" + value.replace(/^P-/i, "").padStart(8, "0"),
                    firstName: firstName.trim(),
                    lastName: lastName.trim(),
                    phone: patientPhone,
                  }).filter(([, entry]) => entry),
                );
                if (!Object.keys(criteria).length) {
                  setNumberError(
                    "Enter a patient number, name, or phone number.",
                  );
                  return;
                }
                run(async () => {
                  setMatches((await api.searchPatients(criteria)).patients);
                  setPatient(null);
                  setSearched(true);
                });
              }}
            >
              <label>
                Patient number{" "}
                <input
                  value={number}
                  aria-invalid={Boolean(numberError)}
                  aria-describedby={
                    numberError ? "lab-number-error" : undefined
                  }
                  onChange={(event) => {
                    setNumberError("");
                    setNumber(event.target.value);
                  }}
                />
                {numberError && (
                  <span
                    className="staff-field-error"
                    id="lab-number-error"
                    role="alert"
                  >
                    {numberError}
                  </span>
                )}
              </label>
              <div className="staff-form-grid">
                <label>
                  First name
                  <input
                    minLength={2}
                    value={firstName}
                    onChange={(event) => {
                      setNumberError("");
                      setFirstName(event.target.value);
                    }}
                  />
                </label>
                <label>
                  Last name
                  <input
                    minLength={2}
                    value={lastName}
                    onChange={(event) => {
                      setNumberError("");
                      setLastName(event.target.value);
                    }}
                  />
                </label>
                <PhoneInput
                  label="Phone number"
                  required={false}
                  onValueChange={(value) => {
                    setNumberError("");
                    setPatientPhone(value);
                  }}
                />
              </div>
              <button className="staff-button" disabled={busy}>
                Find patient
              </button>
              <button
                className="staff-button"
                type="button"
                onClick={() => setEditor(true)}
              >
                Register patient
              </button>
            </form>
            {searched && !matches.length && !patient && (
              <p className="staff-warning" role="status">
                No patient matched your search. Check the details or register a
                new patient.
              </p>
            )}
            {!patient &&
              matches.map((person) => (
                <div key={person.id}>
                  <p>
                    {person.firstName} {person.fatherName} {person.lastName} ·{" "}
                    {person.patientNumber} · DOB {person.dateOfBirth} · Age: {patientAgeLabel(person.dateOfBirth)}
                  </p>
                  <button
                    className="staff-button"
                    onClick={() => usePatient(person)}
                  >
                    Open patient
                  </button>
                </div>
              ))}
            {patient && (
              <p>
                Selected patient: {personName(patient)} ·{" "}
                {patient.patientNumber} · Age: {patientAgeLabel(patient.dateOfBirth)}
              </p>
            )}
            <h2>Tests</h2>
            <label>
              Search tests{" "}
              <input
                value={testQuery}
                onChange={(event) => setTestQuery(event.target.value)}
              />
            </label>
            <h3>Selected tests ({tests.length})</h3>
            {tests.length === 0 && <p>No tests selected.</p>}
            {activeTests
              .filter((test) => tests.includes(test._id))
              .map((test) => (
                <button
                  className="staff-button"
                  key={test._id}
                  onClick={() =>
                    setTests(tests.filter((id) => id !== test._id))
                  }
                >
                  Remove {test.name}
                </button>
              ))}
            {activeTests
              .filter((test) =>
                test.name
                  .toLowerCase()
                  .includes(testQuery.trim().toLowerCase()),
              )
              .map((test) => (
                <label key={test._id}>
                  <input
                    type="checkbox"
                    checked={tests.includes(test._id)}
                    onChange={(event) =>
                      setTests(
                        event.target.checked
                          ? [...tests, test._id]
                          : tests.filter((id) => id !== test._id),
                      )
                    }
                  />{" "}
                  {test.name}
                </label>
              ))}
            <button
              className="staff-button staff-button-primary"
              disabled={!patient || !tests.length}
              onClick={() =>
                run(async () => {
                  const next = await api.lab({
                    action: "create",
                    patientId: patient.id,
                    patientRevision: patient.revision,
                    testIds: tests,
                  });
                  select(next._id);
                  setData((current) => ({
                    ...current,
                    orders: [next, ...current.orders].slice(0, 100),
                  }));
                  setView("specimens");
                  setPatient(null);
                  setMatches([]);
                  setTests([]);
                })
              }
            >
              Create order
            </button>
          </section>
        )}
        {view === "catalogue" && lab && (
          <section className="lab-card">
            <h1>Catalogue</h1>
            {lab && (
              <label>
                Qualified Lab approval reference{" "}
                <input
                  maxLength={250}
                  value={approval}
                  onChange={(event) => setApproval(event.target.value)}
                />
              </label>
            )}
            <ul>
              {data.catalogue.map((test) => (
                <li key={test._id}>
                  {test.name} · {test.specimen} ·{" "}
                  {!test.active
                    ? "Retired"
                    : test.approval
                      ? "Approved"
                      : "Awaiting approval"}
                  {lab && (
                    <button
                      className="staff-button"
                      onClick={() =>
                        setDraft({
                          ...test,
                          template: test.fields
                            .map((field) =>
                              [field.name, field.unit, field.reference].join(
                                " | ",
                              ),
                            )
                            .join("\n"),
                        })
                      }
                    >
                      Edit
                    </button>
                  )}
                  {lab && test.active && (
                    <button
                      className="staff-button"
                      onClick={() => save("retire", test)}
                    >
                      Retire
                    </button>
                  )}
                  {lab && test.active && !test.approval && (
                    <button
                      className="staff-button"
                      disabled={!approval.trim()}
                      onClick={() =>
                        save("approve", test, { reason: approval })
                      }
                    >
                      Record template approval
                    </button>
                  )}
                </li>
              ))}
            </ul>
            {lab && (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  const fields = draft.template
                    .trim()
                    .split("\n")
                    .map((line) => line.split("|").map((part) => part.trim()));
                  const invalid = fields.findIndex(
                    (parts) =>
                      parts.length !== 3 ||
                      parts.some((part) => !part || part.length > 250),
                  );
                  if (invalid !== -1 || fields.length > 30) {
                    setTemplateError(
                      invalid !== -1
                        ? `Correct line ${invalid + 1}. ${templateHint} Each part must be 1–250 characters.`
                        : "Use no more than 30 result lines.",
                    );
                    return;
                  }
                  setTemplateError("");
                  save("save", draft, {
                    name: draft.name,
                    specimen: draft.specimen,
                    group: draft.group,
                    fields: fields.map(([name, unit, reference]) => ({
                      name,
                      unit,
                      reference,
                    })),
                  });
                }}
              >
                <h3>
                  {draft._id ? "Edit catalogue test" : "Add catalogue test"}
                </h3>
                {[
                  ["name", "Test name"],
                  ["specimen", "Required specimen"],
                  ["group", "Specimen group (optional)"],
                ].map(([key, text]) => (
                  <label key={key}>
                    {text}{" "}
                    <input
                      required={key !== "group"}
                      maxLength={250}
                      value={draft[key]}
                      onChange={(event) =>
                        setDraft({ ...draft, [key]: event.target.value })
                      }
                    />
                  </label>
                ))}
                <label>
                  Result fields (one per line: name | unit | reference interval)
                  <textarea
                    aria-invalid={Boolean(templateError)}
                    aria-describedby={
                      templateError ? "lab-template-error" : undefined
                    }
                    value={draft.template}
                    onChange={(event) => {
                      setTemplateError("");
                      setDraft({ ...draft, template: event.target.value });
                    }}
                  />
                  {templateError && (
                    <span
                      className="staff-field-error"
                      id="lab-template-error"
                      role="alert"
                    >
                      {templateError}
                    </span>
                  )}
                </label>
                <button className="staff-button">Save catalogue test</button>
                {draft._id && (
                  <button
                    className="staff-button"
                    type="button"
                    onClick={() => setDraft(empty)}
                  >
                    Stop editing
                  </button>
                )}
              </form>
            )}
          </section>
        )}
      </fieldset>
      {editor && (
        <PatientEditor
          api={api}
          patient={{}}
          onClose={() => setEditor(false)}
          onError={onError}
          onSaved={usePatient}
          duplicateCheckLabel="Check for existing patient"
          registrationLabel="Save patient and return to order"
          onOpen={(patientId) =>
            run(async () =>
              usePatient((await api.readPatient({ patientId })).patient),
            )
          }
        />
      )}
    </section>
  );
}
