import { useEffect, useRef, useState } from "react";
import PatientRegistry from "./PatientRegistry.jsx";
import { isAccessError } from "../lib/staffManagement.js";

export default function QueueAdmission({
  api,
  session,
  kind,
  onAdmitted,
  onClose,
  onError,
}) {
  const [patient, setPatient] = useState(null),
    [reason, setReason] = useState(""),
    [agreed, setAgreed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const pending = useRef(false),
    live = useRef(true),
    request = useRef(null),
    registered = useRef(null);
  const extra = kind === "extra",
    label = extra ? "Admit extra today" : "Accept walk-in";
  const ready = !extra || (agreed && reason.trim() && reason.length <= 240);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  async function admit(details) {
    if (!ready || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    const payload = {
      date: session.date,
      scopeId: session.scopeId,
      sourceSessionId: session.sourceSessionId,
      sessionVersion: session.scheduleSignature,
      kind,
      ...details,
      ...(extra ? { reason: reason.trim(), professionalAgreed: agreed } : {}),
    };
    const fingerprint = JSON.stringify(payload);
    if (request.current?.fingerprint !== fingerprint)
      request.current = { fingerprint, key: crypto.randomUUID() };
    try {
      const result = await api.queueAdmit({
        ...payload,
        idempotencyKey: request.current.key,
      });
      return result;
    } catch (e) {
      if (live.current) {
        setError(e.message);
        if (
          isAccessError(e) &&
          !String(e.code).toLowerCase().includes("unavailable")
        )
          onError?.(e);
      }
      throw e;
    } finally {
      pending.current = false;
      if (live.current) setBusy(false);
    }
  }
  const registryApi = {
    ...api,
    createPatient: async (input) => {
      const result = await admit({ patientCreate: input });
      if (!result) throw Error("Confirm the admission details first.");
      registered.current = result;
      return { patient: result.patient };
    },
  };
  return (
    <section
      className="staff-workspace-card queue-admission"
      aria-label={label}
      aria-busy={busy}
    >
      <h2>{label}</h2>
      <p>
        {session.professionalName} · {session.date} · {session.startTime}–
        {session.endTime}
      </p>
      {extra && (
        <>
          <p>
            One extra patient, agreed with the professional. The usual patient
            limit stays the same.
          </p>
          <label className="staff-field">
            Reason for extra admission
            <input
              required
              maxLength={240}
              value={reason}
              disabled={busy || Boolean(patient)}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={agreed}
              disabled={busy || Boolean(patient)}
              onChange={(e) => setAgreed(e.target.checked)}
            />
            The professional agreed to this extra admission today
          </label>
        </>
      )}
      {error && (
        <p className="staff-error" role="alert">
          {error}
        </p>
      )}
      {ready && !patient && (
        <PatientRegistry
          embedded
          selectionLabel="Choose patient"
          api={registryApi}
          onError={onError}
          registrationLabel={
            extra
              ? "Register and admit extra today"
              : "Register and accept walk-in"
          }
          onSelect={(p) => {
            if (registered.current) {
              const result = registered.current;
              registered.current = null;
              if (live.current) void onAdmitted(result);
            } else setPatient(p);
          }}
        />
      )}
      {patient && (
        <>
          <h3>
            {patient.firstName} {patient.fatherName} {patient.lastName} ·{" "}
            {patient.patientNumber}
          </h3>
          <p>
            Admit this patient to the selected session and check them in now.
          </p>
          <button
            type="button"
            className="staff-button staff-button-primary"
            disabled={busy || !ready}
            onClick={async () => {
              try {
                const result = await admit({
                  patientId: patient.id,
                  patientRevision: patient.revision,
                });
                if (result && live.current) void onAdmitted(result);
              } catch {}
            }}
          >
            {label}
          </button>
          <button
            type="button"
            className="staff-button staff-button-secondary"
            disabled={busy}
            onClick={() => {
              setPatient(null);
              request.current = null;
            }}
          >
            Choose another patient
          </button>
        </>
      )}
      <button
        type="button"
        className="staff-button staff-button-secondary"
        disabled={busy}
        onClick={onClose}
      >
        Cancel admission
      </button>
    </section>
  );
}
