import { useEffect, useRef, useState } from "react";
import StaffDirectory from "./StaffDirectory.jsx";
import StaffProfile from "./StaffProfile.jsx";

const labels = {
  admin: "Admin",
  system_admin: "System Admin",
  clinic_admin: "Clinic Admin",
  lab_admin: "Lab Admin",
  clinic_receptionist: "Clinic Receptionist",
  lab_receptionist: "Lab Receptionist",
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
}) {
  const [view, setView] = useState("workspace");
  const content = useRef(null);
  const roles = workspace.roles ?? user.roles ?? [];
  const directoryAllowed =
    workspace.permissions?.includes("staff:directory") === true;
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
          ...(directoryAllowed ? [["directory", "Staff Directory"]] : []),
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
        {view === "profile" ? (
          <StaffProfile
            api={api}
            onError={onError}
            onPendingChange={onPendingChange}
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
                permitted account controls. Operational appointment, schedule,
                patient and laboratory screens are not included.
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
