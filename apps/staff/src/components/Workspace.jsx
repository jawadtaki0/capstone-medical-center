import { useEffect, useRef, useState } from "react";
import StaffDirectory from "./StaffDirectory.jsx";
import StaffProfile from "./StaffProfile.jsx";
import OperationsPanel from "./OperationsPanel.jsx";
import PatientRegistry from "./PatientRegistry.jsx";
import { PATIENT_ROLES } from "../../shared/patient-input.js";

const labels = {
  admin: "Admin",
  clinic_admin: "Clinic Admin",
  lab_admin: "Lab Admin",
  receptionist: "Receptionist",
};

export function roleLabel(role) {
  return labels[role] ?? role.replace(/[_-]/g, " ");
}

export default function Workspace({
  api,
  user,
  workspace,
  timing,
  onContinue,
  busy,
  onError,
  onSensitiveAction,
  onPendingChange,
  onPasswordChanged,
}) {
  const [view, setView] = useState("workspace");
  const content = useRef(null);
  const roles = workspace.roles ?? user.roles ?? [];
  const directoryAllowed =
    workspace.permissions?.includes("staff:directory") === true;
  const patientsAllowed =
    roles.length > 0 && roles.every((role) => PATIENT_ROLES.includes(role));
  const operationsAllowed =
    workspace.permissions?.includes("operations:view") === true;
  useEffect(() => {
    content.current?.querySelector("h1")?.focus({ preventScroll: true });
  }, [view]);
  return (
    <div className="staff-workspace">
      <aside className="staff-sidebar" aria-label="Staff workspace navigation">
        <p className="staff-eyebrow">YOUR WORKSPACE</p>
        {[
          ["workspace", "Workspace"],
          ["profile", "My Profile"],
          ...(patientsAllowed ? [["patients", "Patients"]] : []),
          ...(directoryAllowed ? [["directory", "Staff Directory"]] : []),
          ...(operationsAllowed
            ? [
                ["professionals", "Professionals"],
                ["schedule", "Schedules"],
                ...(roles.includes("Admin")
                  ? [["registry", "Clinics & services"]]
                  : []),
              ]
            : []),
        ].map(([key, label]) => (
          <button
            type="button"
            key={key}
            disabled={busy}
            aria-current={view === key ? "page" : undefined}
            className="staff-sidebar-link"
            onClick={() => setView(key)}
          >
            {label}
          </button>
        ))}
        <p className="staff-sidebar-label">Assigned roles</p>
        <ul>
          {roles.map((role) => (
            <li key={role}>{roleLabel(role)}</li>
          ))}
        </ul>
      </aside>
      <section
        id="workspace"
        ref={content}
        className="staff-workspace-content"
        tabIndex={-1}
        aria-label="Staff workspace content"
      >
        {timing.warning && (
          <div className="staff-idle-warning" role="alert">
            <div>
              <h2>Your session is about to expire</h2>
              <p>
                You have been inactive.{" "}
                <span aria-live="off">
                  {timing.secondsRemaining} seconds remaining.
                </span>
              </p>
            </div>
            <button
              className="staff-button staff-button-primary"
              type="button"
              disabled={busy}
              onClick={onContinue}
            >
              Continue session
            </button>
          </div>
        )}
        {view === "patients" && patientsAllowed ? (
          <PatientRegistry
            api={api}
            onError={onError}
            onPendingChange={onPendingChange}
          />
        ) : operationsAllowed &&
          ["professionals", "schedule", "registry"].includes(view) ? (
          <OperationsPanel
            key={view}
            api={api}
            mode={view}
            onError={onError}
            onSensitiveAction={onSensitiveAction}
            onPendingChange={onPendingChange}
          />
        ) : view === "profile" ? (
          <StaffProfile
            api={api}
            onError={onError}
            onPendingChange={onPendingChange}
            onPasswordChanged={onPasswordChanged}
          />
        ) : view === "directory" && directoryAllowed ? (
          <StaffDirectory
            api={api}
            user={user}
            onError={onError}
            onSensitiveAction={onSensitiveAction}
            onPendingChange={onPendingChange}
          />
        ) : (
          <>
            <p className="staff-eyebrow">PERMISSION-CHECKED FOUNDATION</p>
            <h1 id="workspace-title" tabIndex={-1}>
              {workspace.heading ?? "Staff workspace"}
            </h1>
            <p className="staff-intro">
              {workspace.description ??
                "Your individual session has been verified by the local staff server."}
            </p>
            <div className="staff-workspace-card">
              <h2>Signed in as {user.username}</h2>
              <p>
                View your private profile, edit your address and request a
                verified email replacement. Phone replacement remains
                unavailable. Authorized managers can use the staff directory and
                permitted account controls. Authorized operational roles can
                review professional and schedule drafts. The Patients registry
                supports basic records only. Appointment and clinical/laboratory
                workflows are not included.
              </p>
              <p className="staff-help">
                Permissions are checked by the server. A department or visible
                menu does not grant additional access.
              </p>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
