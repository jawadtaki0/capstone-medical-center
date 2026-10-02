const labels = {
  admin: "Admin", system_admin: "System Admin", clinic_admin: "Clinic Admin", lab_admin: "Lab Admin",
  clinic_receptionist: "Clinic Receptionist", lab_receptionist: "Lab Receptionist",
};

export function roleLabel(role) { return labels[role] ?? role.replace(/[_-]/g, " "); }

export default function Workspace({ user, workspace, timing, onContinue, busy }) {
  const roles = workspace.roles ?? user.roles ?? [];
  return <div className="staff-workspace">
    <aside className="staff-sidebar" aria-label="Staff workspace navigation"><p className="staff-eyebrow">YOUR WORKSPACE</p><a href="#workspace" aria-current="page" className="staff-sidebar-link">Workspace</a><p className="staff-sidebar-label">Assigned roles</p><ul>{roles.map((role) => <li key={role}>{roleLabel(role)}</li>)}</ul></aside>
    <section id="workspace" className="staff-workspace-content" tabIndex={-1} aria-labelledby="workspace-title">
      {timing.warning && <div className="staff-idle-warning" role="alert"><div><h2>Your session is about to expire</h2><p>You have been inactive. <span aria-live="off">{timing.secondsRemaining} seconds remaining.</span></p></div><button className="staff-button staff-button-primary" type="button" disabled={busy} onClick={onContinue}>Continue session</button></div>}
      <p className="staff-eyebrow">PERMISSION-CHECKED FOUNDATION</p><h1 id="workspace-title">{workspace.heading ?? "Staff workspace"}</h1><p className="staff-intro">{workspace.description ?? "Your individual session has been verified by the local staff server."}</p>
      <div className="staff-workspace-card"><h2>Signed in as {user.username}</h2><p>This increment provides staff setup, sign-in, authenticator verification, session expiry, and sign-out. Operational appointment, schedule, patient, and laboratory screens are not included.</p><p className="staff-help">Permissions are checked by the server. A department or visible menu does not grant additional access.</p></div>
    </section>
  </div>;
}
