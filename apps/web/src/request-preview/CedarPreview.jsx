import { useState } from "react";
import RequestInbox from "./RequestInbox.jsx";
import { previewStore } from "./store.js";

export default function CedarPreview() {
  const [view, setView] = useState("requests"),
    [role, setRole] = useState("Receptionist"),
    [assigned, setAssigned] = useState(true),
    [scenario, setScenario] = useState("ready");
  return (
    <div className="staff-app cedar-preview">
      <a className="staff-skip-link" href="#cedar-main">
        Skip to content
      </a>
      <div className="preview-banner">
        <div>
          <strong>CEDAR VISUAL PREVIEW · SYNTHETIC ONLY</strong>
          <span>
            No real sign-in, registry write, booking, delivery or WhatsApp
            opening. This is not server authorization.
          </span>
        </div>
        <nav aria-label="Preview pages">
          <a
            href="/request-preview.html"
            target="_blank"
            rel="noopener noreferrer"
          >
            Public request ↗
          </a>
          <button
            type="button"
            onClick={() => {
              if (window.confirm("Reset synthetic preview memory only?"))
                previewStore.reset();
            }}
          >
            Reset preview
          </button>
        </nav>
      </div>
      <header className="staff-header">
        <div className="staff-brand">
          <span className="staff-brand-mark" aria-hidden="true">
            +
          </span>
          <div>
            <strong>Cedar Staff</strong>
            <span className="staff-tagline">
              CLINIC REQUEST WORKSPACE · VISUAL REVIEW
            </span>
          </div>
        </div>
        <div className="staff-header-actions">
          <span className="request-status sync-current">
            Simulated local server
          </span>
          <span className="staff-signed-in">
            Previewing as <strong>{role}</strong>
          </span>
        </div>
      </header>
      <div className="request-preview-tools">
        <label>
          Preview role
          <select
            aria-label="Preview role"
            value={role}
            onChange={(e) => setRole(e.target.value)}
          >
            {["Admin", "Receptionist", "Clinic Admin", "Lab Admin"].map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
        </label>
        <label className="request-checkbox">
          <input
            type="checkbox"
            checked={assigned}
            onChange={(e) => setAssigned(e.target.checked)}
          />
          Synthetic clinic assignment
        </label>
        <label>
          Preview state
          <select
            aria-label="Preview state"
            value={scenario}
            onChange={(e) => setScenario(e.target.value)}
          >
            <option value="ready">Ready</option>
            <option value="loading">Loading</option>
            <option value="unavailable">Unavailable</option>
            <option value="empty">Empty inbox</option>
          </select>
        </label>
      </div>
      <div className="staff-workspace">
        <aside className="staff-sidebar" aria-label="Staff preview navigation">
          <p className="staff-eyebrow">YOUR WORKSPACE</p>
          {[
            "Workspace",
            "My Profile",
            "Patients",
            "Bookings",
            "Professionals",
            "Schedules",
          ].map((label) => (
            <button
              key={label}
              className="staff-sidebar-link"
              disabled
              type="button"
              title="Existing screen is outside this visual preview"
            >
              {label}
            </button>
          ))}
          <button
            className="staff-sidebar-link"
            aria-current={view === "requests" ? "page" : undefined}
            type="button"
            onClick={() => setView("requests")}
          >
            Website requests
          </button>
          <button
            className="staff-sidebar-link"
            aria-current={view === "notices" ? "page" : undefined}
            type="button"
            onClick={() => setView("notices")}
          >
            Notification worklist
          </button>
          <p className="staff-sidebar-label">Assigned scope (synthetic)</p>
          <p>{assigned ? "Clinic" : "None"}</p>
          <p className="request-muted">
            Other sidebar items preserve context only. This preview cannot open
            operational workflows.
          </p>
        </aside>
        <main id="cedar-main" className="staff-workspace-content" tabIndex={-1}>
          <RequestInbox
            key={view}
            role={role}
            assigned={assigned}
            notifications={view === "notices"}
            scenario={scenario}
          />
        </main>
      </div>
      <footer className="staff-footer">
        Synthetic design preview only. No normal configuration, patient data,
        booking or message is changed.
      </footer>
    </div>
  );
}
