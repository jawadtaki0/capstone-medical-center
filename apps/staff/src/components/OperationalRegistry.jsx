import { useEffect, useId, useRef, useState } from "react";

export default function OperationalRegistry({
  state,
  api,
  onEdit,
  onAssign,
  onError,
}) {
  const id = useId(),
    live = useRef(true),
    submitting = useRef(false);
  const [staff, setStaff] = useState(null),
    [retry, setRetry] = useState(0),
    [error, setError] = useState(""),
    [accountId, setAccountId] = useState(""),
    [selected, setSelected] = useState([]),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    live.current = true;
    let current = true;
    setStaff(null);
    setError("");
    api
      .staffDirectory()
      .then((result) => {
        if (current) setStaff(result.staff);
      })
      .catch((failure) => {
        if (current) {
          setError(failure.message);
          onError?.(failure);
        }
      });
    return () => {
      current = false;
      live.current = false;
    };
  }, [api, retry]);
  function choose(value) {
    setAccountId(value);
    setSelected(state.grants.find((g) => g.id === value)?.scopeIds ?? []);
    setConfirmed(false);
  }
  async function assign(event) {
    event.preventDefault();
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      await onAssign({
        accountId,
        scopeIds: selected,
        expectedRevision:
          state.grants.find((g) => g.id === accountId)?.revision ?? 0,
        confirmed,
      });
      if (live.current) setConfirmed(false);
    } catch (failure) {
      if (live.current) setError(failure.message);
    } finally {
      submitting.current = false;
      if (live.current) setBusy(false);
    }
  }
  return (
    <>
      <div className="staff-actions">
        <button
          className="staff-button staff-button-primary"
          type="button"
          onClick={() =>
            onEdit("scopes", {
              id: `scope:${crypto.randomUUID()}`,
              name: "",
              kind: "clinic",
              active: true,
            })
          }
        >
          Add clinic/service
        </button>
      </div>
      <ul className="operational-list">
        {state.scopes.map((s) => (
          <li key={s.id}>
            <div>
              <h2>{s.name}</h2>
              <p>
                {s.kind === "clinic" ? "Clinic" : "Separate public service"} ·{" "}
                {s.active ? "Active" : "Inactive"}
              </p>
            </div>
            <button
              className="staff-button"
              type="button"
              onClick={() => onEdit("scopes", s)}
            >
              Edit {s.name}
            </button>
          </li>
        ))}
      </ul>
      {!state.scopes.length && (
        <p role="status">
          No clinic/service registry entries yet. No assignments are inferred
          from departments.
        </p>
      )}
      <section className="staff-workspace-card">
        <h2>Explicit staff scope assignments</h2>
        <p>
          Only Admin changes assignments. Roles still determine what each
          assigned person may do. Lab Admin may manage an explicitly assigned
          service, including Audiometry; service names do not grant permission.
        </p>
        {error && (
          <p className="staff-error" role="alert">
            {error}
          </p>
        )}
        {!staff ? (
          <>
            <p role="status">
              {error ? "Staff choices unavailable." : "Loading staff choices…"}
            </p>
            {error && (
              <button
                className="staff-button"
                onClick={() => setRetry((n) => n + 1)}
              >
                Retry staff list
              </button>
            )}
          </>
        ) : (
          <form className="staff-form" onSubmit={assign}>
            <fieldset disabled={busy} className="operational-fields">
              <div className="staff-field">
                <label htmlFor={`${id}-account`}>Staff account</label>
                <select
                  id={`${id}-account`}
                  value={accountId}
                  onChange={(e) => choose(e.target.value)}
                  required
                >
                  <option value="">Choose enabled staff</option>
                  {staff
                    .filter(
                      (a) =>
                        a.status !== "disabled" && !a.roles.includes("Admin"),
                    )
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name} — {a.username} ({a.roles.join(", ")})
                      </option>
                    ))}
                </select>
              </div>
              <fieldset>
                <legend>Assigned clinics/services</legend>
                {state.scopes.map((s) => (
                  <label className="staff-checkbox" key={s.id}>
                    <input
                      type="checkbox"
                      disabled={!s.active && !selected.includes(s.id)}
                      checked={selected.includes(s.id)}
                      onChange={(e) => {
                        setSelected(
                          e.target.checked
                            ? [...selected, s.id]
                            : selected.filter((x) => x !== s.id),
                        );
                        setConfirmed(false);
                      }}
                    />
                    {s.name} ({s.kind})
                  </label>
                ))}
              </fieldset>
              <label className="staff-checkbox">
                <input
                  type="checkbox"
                  required
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                I confirm these explicit scope assignments, including any
                removals.
              </label>
            </fieldset>
            <button
              className="staff-button staff-button-primary"
              type="submit"
              disabled={busy || !accountId}
            >
              Save assignments
            </button>
          </form>
        )}
      </section>
    </>
  );
}
