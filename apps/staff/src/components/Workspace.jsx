import WebsiteRequests from "./WebsiteRequests.jsx";
import RequestScreenBoundary from "./RequestScreenBoundary.jsx";
import BookingPanel from "./BookingPanel.jsx";
import QueuePanel from "./QueuePanel.jsx";
import { useEffect, useRef, useState } from "react";
import StaffDirectory from "./StaffDirectory.jsx";
import StaffProfile from "./StaffProfile.jsx";
import OperationsPanel from "./OperationsPanel.jsx";
import PatientRegistry from "./PatientRegistry.jsx";
import Today from "./Today.jsx";
import RequestActionCount from "./RequestActionCount.jsx";
import { startSummaryRefresh } from "../lib/operationalSummary.js";

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
  const [view, setView] = useState("today");
  const [target, setTarget] = useState({});
  const [summary, setSummary] = useState(null);
  const [summaryError, setSummaryError] = useState("");
  const [intakeError, setIntakeError] = useState("");
  const [phoneQueue, setPhoneQueue] = useState(null);
  const phoneRefresh = useRef(0);
  const summaryPoll = useRef(null),
    summaryGeneration = useRef(0),
    live = useRef(false);
  const callbacks = useRef({ onError, expired: timing.expired });
  callbacks.current = { onError, expired: timing.expired };
  const content = useRef(null);
  const roles = workspace.roles ?? user.roles ?? [];
  const capabilities = summary?.capabilities ?? {};
  const directoryAllowed = capabilities.directory === true;
  const patientsAllowed = capabilities.patients === true;
  const bookingsAllowed = capabilities.bookingView === true;
  const operationsAllowed = capabilities.operations === true;
  async function refreshPhoneQueue() {
    const version = ++phoneRefresh.current;
    try {
      const queue = await api.websiteRequests({
        action: "phoneVerification",
        phoneAction: "list",
      });
      if (
        live.current &&
        !callbacks.current.expired &&
        version === phoneRefresh.current
      )
        setPhoneQueue(queue);
    } catch {
      if (live.current && version === phoneRefresh.current) setPhoneQueue(null);
    }
  }
  useEffect(() => {
    if (capabilities.requests && !timing.expired) {
      void refreshPhoneQueue();
      const timer = setInterval(() => {
        if (!document.hidden) void refreshPhoneQueue();
      }, 30000);
      return () => {
        clearInterval(timer);
        phoneRefresh.current++;
      };
    }
    setPhoneQueue(null);
  }, [api, user.id, capabilities.requests, timing.expired]);
  useEffect(() => {
    live.current = true;
    const version = ++summaryGeneration.current;
    summaryPoll.current = startSummaryRefresh({
      read: () => api.operationalSummary(),
      current: () =>
        live.current &&
        !callbacks.current.expired &&
        version === summaryGeneration.current,
      onValue: (value) => {
        setSummary(value);
        setSummaryError("");
      },
      onError: (error) => {
        setSummaryError(error.message);
        // Summary/database unavailability is not proof of session expiry.
        // Real authorization failures clear all visible metadata immediately.
        if (
          /expired|revoked|auth_required|authentication_failed|permission_denied/i.test(
            error.code ?? "",
          )
        ) {
          setSummary(null);
          callbacks.current.onError?.(error);
        }
      },
    });
    return () => {
      live.current = false;
      summaryGeneration.current++;
      summaryPoll.current?.stop();
    };
  }, [api, user.id, user.username]);
  useEffect(() => {
    if (timing.expired) {
      summaryGeneration.current++;
      summaryPoll.current?.stop();
      setSummary(null);
    }
  }, [timing.expired]);
  useEffect(() => {
    if (!capabilities.requests || timing.expired) {
      setIntakeError("");
      return;
    }
    let suspended = false;
    const intake = startSummaryRefresh({
      read: () => api.websiteRequests({ action: "refresh" }),
      current: () =>
        live.current &&
        !callbacks.current.expired &&
        !document.hidden &&
        !suspended,
      onValue: () => {
        setIntakeError("");
        summaryPoll.current?.refresh();
      },
      onError: (error) => {
        setIntakeError(error.message);
        if (error.code === "requests_disabled") suspended = true;
        if (
          /expired|revoked|auth_required|authentication_failed|permission_denied|request_forbidden/i.test(
            error.code ?? "",
          )
        ) {
          suspended = true;
          setSummary(null);
          summaryPoll.current?.refresh();
        }
      },
    });
    const visible = () => {
      if (!document.hidden) void intake.refresh();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      intake.stop();
      document.removeEventListener("visibilitychange", visible);
    };
  }, [api, capabilities.requests, timing.expired]);
  function navigate(next) {
    setTarget(next);
    setView(next.view);
  }
  async function openActivity(item) {
    const version = summaryGeneration.current;
    try {
      await api.viewOperationalActivity({ eventId: item.id });
      if (
        !live.current ||
        callbacks.current.expired ||
        version !== summaryGeneration.current
      )
        return;
      summaryPoll.current?.refresh();
      navigate({
        view:
          item.target.section === "website"
            ? "website-updates"
            : item.target.section,
        tab: item.target.tab,
        requestId: item.target.recordId,
        noticeId: item.target.noticeId,
      });
    } catch (error) {
      if (live.current && version === summaryGeneration.current)
        setSummaryError(error.message);
    }
  }
  useEffect(() => {
    content.current?.querySelector("h1")?.focus({ preventScroll: true });
  }, [view]);
  return (
    <div className="staff-workspace">
      <aside className="staff-sidebar" aria-label="Staff workspace navigation">
        <p className="staff-eyebrow">YOUR WORKSPACE</p>
        {[
          ["today", "Today"],
          ["profile", "My Profile"],
          ...(capabilities.requests ? [["requests", "Website requests"]] : []),
          ...(patientsAllowed ? [["patients", "Patients"]] : []),
          ...(bookingsAllowed ? [["bookings", "Bookings"]] : []),
          ...(capabilities.queue ? [["queue", "Queue"]] : []),
          ...(directoryAllowed ? [["directory", "Staff Directory"]] : []),
          ...(operationsAllowed
            ? [
                ...(capabilities.professionals
                  ? [["professionals", "Professionals"]]
                  : []),
                [
                  "schedule",
                  capabilities.serviceHours && !capabilities.professionals
                    ? "Service hours"
                    : "Schedules",
                ],
                ...(capabilities.schedules
                  ? [["website-updates", "Website updates"]]
                  : []),
                ...(capabilities.centerSettings
                  ? [["registry", "Center settings"]]
                  : []),
              ]
            : []),
        ].map(([key, label]) => (
          <button
            type="button"
            key={key}
            disabled={busy}
            aria-current={view === key ? "page" : undefined}
            className={`staff-sidebar-link ${key === "requests" && (summary?.counts.requestsAwaitingDecision > 0 || summary?.counts.messagesToSend > 0 || phoneQueue?.count > 0) ? "needs-action" : ""}`}
            onClick={() => navigate({ view: key })}
          >
            <span>{label}</span>
            {key === "requests" && (
              <span className="staff-request-sidebar-counts">
                <span className="staff-request-count-row">
                  <span>Requests awaiting decision</span>
                  <RequestActionCount
                    value={summary?.counts.requestsAwaitingDecision}
                    label="requests awaiting decision"
                    stale={Boolean(summaryError)}
                  />
                </span>
                <span className="staff-request-count-row">
                  <span>Messages to send</span>
                  <RequestActionCount
                    value={summary?.counts.messagesToSend}
                    label="messages needing action"
                    stale={Boolean(summaryError)}
                  />
                </span>
                {phoneQueue && (
                  <span className="staff-request-count-row">
                    <span>Phone codes to send</span>
                    <RequestActionCount
                      value={phoneQueue.count}
                      label="phone codes to send"
                    />
                  </span>
                )}
              </span>
            )}
          </button>
        ))}
        <p className="staff-sidebar-label">Assigned roles</p>
        {summaryError && (
          <p className="staff-help" role="status">
            Action counts could not be refreshed. Any displayed counts are the
            last known values.
          </p>
        )}
        {intakeError && (
          <p className="staff-help" role="status">
            Request synchronization unavailable. Open Website requests for
            details; existing work is retained.
          </p>
        )}
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
        {view === "requests" && capabilities.requests ? (
          <RequestScreenBoundary>
            <WebsiteRequests
              api={api}
              onError={onError}
              initialView={target.tab}
              initialRequestId={target.requestId}
              initialNoticeId={target.noticeId}
              onResolved={() => summaryPoll.current?.refresh()}
              actionCounts={summary?.counts}
              phoneQueue={phoneQueue}
              refreshPhoneQueue={refreshPhoneQueue}
              countsError={Boolean(summaryError)}
            />
          </RequestScreenBoundary>
        ) : view === "queue" && capabilities.queue ? (
          <QueuePanel
            api={api}
            onError={onError}
            onPendingChange={onPendingChange}
          />
        ) : view === "bookings" && bookingsAllowed ? (
          <BookingPanel
            api={api}
            onError={onError}
            onPendingChange={onPendingChange}
            onResolved={() => summaryPoll.current?.refresh()}
          />
        ) : view === "patients" && patientsAllowed ? (
          <PatientRegistry
            api={api}
            onError={onError}
            onPendingChange={onPendingChange}
          />
        ) : operationsAllowed &&
          ["professionals", "schedule", "registry", "website-updates"].includes(
            view,
          ) ? (
          <OperationsPanel
            key={view}
            api={api}
            mode={view}
            initialScheduleMode={target.scheduleMode}
            initialAffectedBookings={target.affectedBookings}
            unpublishedChanges={summary?.counts.unpublishedChanges}
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
          <Today
            summary={summary}
            error={summaryError || intakeError}
            onNavigate={navigate}
            onActivity={openActivity}
            onRefresh={() => summaryPoll.current?.refresh()}
            busy={busy}
          />
        )}
      </section>
    </div>
  );
}
