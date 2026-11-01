import BookingRecords from "./BookingRecords.jsx";
import LoadingStatus from "../../../../shared/ui/LoadingStatus.jsx";
import "./bookings.css";
import { useEffect, useId, useRef, useState } from "react";
import OperationalEditor from "./OperationalEditor.jsx";
import OneDateEditor from "./OneDateEditor.jsx";
import OperationalPublish from "./OperationalPublish.jsx";
import OperationalRegistry from "./OperationalRegistry.jsx";
import PublicationDelivery from "./PublicationDelivery.jsx";
import {
  centerToday,
  cleanOperationalRecord,
  newSession,
  scheduleForDate,
  WEEKDAYS,
} from "../lib/operations.js";
import { isAccessError } from "../lib/staffManagement.js";
import "./operations.css";

export default function OperationsPanel({
  api,
  mode,
  onError,
  onSensitiveAction,
  onPendingChange,
  initialScheduleMode = "weekly",
  initialAffectedBookings = false,
  unpublishedChanges,
}) {
  const id = useId(),
    alive = useRef(true),
    generation = useRef(0),
    requestBusy = useRef(false),
    loading = useRef(false),
    callbacks = useRef({ onError, onPendingChange });
  callbacks.current = { onError, onPendingChange };
  const [state, setState] = useState(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [refreshing, setRefreshing] = useState(false),
    [editor, setEditor] = useState(null),
    [publishing, setPublishing] = useState(false),
    [query, setQuery] = useState(""),
    [date, setDate] = useState(centerToday()),
    [day, setDay] = useState(1),
    [dated, setDated] = useState(initialScheduleMode === "dated"),
    [preview, setPreview] = useState(null),
    [showBookings, setShowBookings] = useState(initialAffectedBookings),
    [hasAffectedBookings, setHasAffectedBookings] = useState(false);
  function failure(value) {
    if (!alive.current) return;
    setError(value.message);
    if (isAccessError(value)) callbacks.current.onError?.(value);
  }
  async function load({ announce = false } = {}) {
    if (announce && loading.current) return;
    loading.current = true;
    setRefreshing(true);
    const version = ++generation.current;
    setError("");
    setNotice("");
    try {
      const value = await api.operationalState();
      if (alive.current && version === generation.current) {
        setState(value);
        if (
          ["professionals", "schedule", "website-updates"].includes(mode) &&
          value.scopes.some(
            (scope) => scope.kind === "clinic" && scope.access.edit,
          ) &&
          api.affectedBookings
        ) {
          api
            .affectedBookings({})
            .then((result) => {
              if (alive.current && version === generation.current) {
                const relevant = Boolean(result.bookings?.length);
                setHasAffectedBookings(relevant);
                if (!relevant) setShowBookings(false);
              }
            })
            .catch((failure) => {
              if (
                alive.current &&
                version === generation.current &&
                isAccessError(failure)
              )
                callbacks.current.onError?.(failure);
            });
        } else {
          setHasAffectedBookings(false);
          setShowBookings(false);
        }
        if (announce) setNotice("Drafts refreshed");
      }
    } catch (value) {
      if (version === generation.current) failure(value);
    } finally {
      if (version === generation.current) {
        loading.current = false;
        if (alive.current) setRefreshing(false);
      }
    }
  }
  useEffect(() => {
    alive.current = true;
    load();
    return () => {
      alive.current = false;
      generation.current++;
      callbacks.current.onPendingChange?.(false);
    };
  }, [api]);
  useEffect(() => {
    callbacks.current.onPendingChange?.(Boolean(editor || publishing || busy));
  }, [editor, publishing, busy]);
  async function mutate(action) {
    if (requestBusy.current) throw new Error("Wait for the current operation.");
    requestBusy.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await onSensitiveAction(() => {
        if (!alive.current)
          throw Object.assign(
            new Error(
              "This operational action is no longer current. Reopen the screen.",
            ),
            { code: "ACTION_SUPERSEDED" },
          );
        return action();
      });
      if (alive.current) {
        await load();
        setNotice(
          result.patientLimitUpdated
            ? "Patient limit updated. It takes effect immediately; no website publication is required."
            : result.published
              ? "Published locally. Website delivery is pending; receiver acceptance has not yet been confirmed."
              : result.retryScheduled
                ? "Retry scheduled. Waiting for receiver acknowledgement."
                : result.publicDraftChanged
                  ? "Public changes saved as drafts. Any patient-limit changes take effect immediately; the website changes only after publication."
                  : "Saved to the local staff authority. Unpublished edits remain drafts.",
        );
        setPreview(null);
      }
      return result;
    } catch (value) {
      failure(value);
      throw value;
    } finally {
      requestBusy.current = false;
      if (alive.current) setBusy(false);
    }
  }
  const edit = (type, record) => {
    setError("");
    setEditor({ type, record });
  };
  const canEdit = state?.scopes.some((s) => s.access.edit),
    canPublish = state?.scopes.some((s) => s.access.publish),
    editableScopes =
      state?.scopes.filter((s) => s.access.edit && s.active) ?? [];
  const heading =
    mode === "professionals"
      ? "Professionals"
      : mode === "registry"
        ? "Center settings"
        : mode === "website-updates"
          ? "Website updates"
          : "Schedules";
  const names = (scopeId) =>
    state.scopes.find((s) => s.id === scopeId)?.name ?? scopeId;
  const professionalName = (professionalId) =>
    state.professionals.find((p) => p.id === professionalId)?.name ??
    "Service hours";
  const filtered =
    state?.professionals.filter((p) =>
      `${p.name} ${p.specialty}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
    ) ?? [];
  const sessions = state
    ? dated
      ? scheduleForDate(state, date)
      : state.sessions.filter((s) => s.weekday === day)
    : [];
  return (
    <section className="operational-page">
      <p className="staff-eyebrow">CENTER-LOCAL · ASIA/BEIRUT</p>
      <h1 tabIndex={-1}>{heading}</h1>
      {hasAffectedBookings && (
        <>
          <button
            type="button"
            className="staff-button"
            onClick={() => setShowBookings(!showBookings)}
          >
            {showBookings
              ? "Close affected bookings"
              : "Review affected bookings"}
          </button>
          {showBookings && (
            <BookingRecords
              api={api}
              affected
              onError={onError}
              refresh={state.head}
            />
          )}
        </>
      )}
      <p className="staff-intro">
        {mode === "website-updates"
          ? "Review private changes before updating the website. A saved local version is not proof of website delivery."
          : mode === "registry"
            ? "Manage the clinic and separate services. Staff access is managed separately in Staff Directory."
            : "Changes stay private drafts until an authorized website update. Existing bookings and manual patient limits remain protected."}
      </p>
      {canPublish && Number.isSafeInteger(unpublishedChanges) && (
        <p
          className={unpublishedChanges > 0 ? "staff-notice" : "staff-help"}
          role="status"
        >
          {unpublishedChanges > 0
            ? `Unpublished changes: ${unpublishedChanges}`
            : "No unpublished public changes"}
        </p>
      )}
      {error && (
        <p className="staff-error" role="alert">
          {error}
        </p>
      )}
      {state?.publicationBlocked && (
        <p className="staff-error" role="alert">
          Publication configuration needs operator reconciliation. Drafts and
          other local staff functions remain available; no replacement source is
          created automatically.
        </p>
      )}
      {notice && (
        <p className="staff-notice" role="status">
          {notice}
        </p>
      )}
      <div className="staff-actions">
        <button
          className="staff-button"
          type="button"
          disabled={busy || refreshing}
          aria-busy={refreshing}
          onClick={() => load({ announce: true })}
        >
          {refreshing && (
            <span className="operational-loading" aria-hidden="true" />
          )}
          {refreshing ? "Reloading drafts…" : "Reload drafts"}
        </button>
        {canPublish && mode === "website-updates" && (
          <button
            className="staff-button staff-button-primary"
            disabled={busy || refreshing || state?.publicationBlocked}
            type="button"
            onClick={() => setPublishing(true)}
          >
            Review & update website
          </button>
        )}
      </div>
      {!state ? (
        error ? (
          <p role="status">
            Operational data unavailable. Use Reload drafts to retry.
          </p>
        ) : (
          <LoadingStatus label="Loading operational data…" />
        )
      ) : (
        <>
          {mode === "website-updates" && (
            <>
              <p className="staff-help">
                Review professional details, sessions, dated changes and opening
                hours for the scopes you are authorized to publish. Private
                patient limits never appear on the website.
              </p>
              <PublicationDelivery
                configured={state.deliveryConfigured}
                deliveries={state.deliveries}
                busy={busy}
                refreshing={refreshing}
                onRefresh={() => load()}
                onRetry={(deliveryId) =>
                  mutate(() =>
                    api.retryOperationalDelivery({ deliveryId }),
                  ).catch(() => {})
                }
              />
              <details>
                <summary>Technical details</summary>
                <p>
                  Draft revision {state.revision} · Published version{" "}
                  {state.head}. No assigned scopes means no operational
                  authority.
                </p>
              </details>
            </>
          )}
          {!state.scopes.length && !state.isAdmin && (
            <p role="status">
              No operational scopes are assigned to your current roles. Ask an
              Admin; department labels do not grant access.
            </p>
          )}
          {mode === "registry" && state.isAdmin && (
            <OperationalRegistry
              state={state}
              api={api}
              onEdit={edit}
              onError={(value) => {
                if (isAccessError(value)) onError?.(value);
              }}
              onAssign={(payload) =>
                mutate(() => api.assignOperationalScopes(payload))
              }
            />
          )}
          {mode === "professionals" && (
            <>
              <div className="staff-field">
                <label htmlFor={`${id}-search`}>
                  Search professionals by name or specialty
                </label>
                <div
                  className="operational-search"
                  data-filled={Boolean(query)}
                >
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    aria-hidden="true"
                    focusable="false"
                  >
                    <circle cx="10.5" cy="10.5" r="6.5" />
                    <path d="m15.5 15.5 5 5" />
                  </svg>
                  <input
                    id={`${id}-search`}
                    type="search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </div>
              </div>
              {editableScopes.some((s) => s.kind === "clinic") && (
                <button
                  className="staff-button staff-button-primary"
                  onClick={() =>
                    edit("professionals", {
                      id: `doctor:${crypto.randomUUID()}`,
                      name: "",
                      specialty: "",
                      kind: "doctor",
                      gender: "neutral",
                      active: true,
                    })
                  }
                >
                  Add professional
                </button>
              )}
              <p role="status">
                {filtered.length
                  ? `${filtered.length} assigned professionals shown.`
                  : "No matching professionals in your assigned scopes."}
              </p>
              <ul className="operational-list">
                {filtered.map((p) => (
                  <li key={p.id}>
                    <div>
                      <h2>{p.name}</h2>
                      <p>
                        {p.specialty} ·{" "}
                        {p.kind === "doctor" ? "Doctor" : "Specialist"} ·{" "}
                        {p.active ? "Active" : "Inactive — history retained"}
                      </p>
                      <p className="staff-help">
                        {p.scopeIds.map(names).join(", ")}
                      </p>
                    </div>
                    {p.canEdit ? (
                      <button
                        className="staff-button"
                        onClick={() => edit("professionals", p)}
                      >
                        Edit {p.name}
                      </button>
                    ) : (
                      <span className="staff-help">
                        Read-only; every linked clinic must be authorized to
                        edit a shared profile.
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
          {mode === "schedule" && (
            <>
              <div className="operational-schedule-controls">
                <div
                  className="staff-actions"
                  role="group"
                  aria-label="Schedule view"
                >
                  <button
                    type="button"
                    className="staff-button"
                    aria-pressed={!dated}
                    onClick={() => setDated(false)}
                  >
                    Weekly schedule
                  </button>
                  <button
                    type="button"
                    className="staff-button"
                    aria-pressed={dated}
                    onClick={() => setDated(true)}
                  >
                    Changes for a date
                  </button>
                </div>
                <div className="staff-field">
                  {dated ? (
                    <>
                      <label htmlFor={`${id}-date`}>Date in Asia/Beirut</label>
                      <input
                        id={`${id}-date`}
                        type="date"
                        value={date}
                        onChange={(e) => setDate(e.target.value)}
                      />
                    </>
                  ) : (
                    <div
                      className="operational-weekdays"
                      role="group"
                      aria-label="Recurring weekday"
                    >
                      {WEEKDAYS.map((name, n) => (
                        <button
                          type="button"
                          className="staff-button"
                          aria-pressed={day === n}
                          onClick={() => setDay(n)}
                          key={name}
                        >
                          {name}
                          <span>
                            {
                              state.sessions.filter(
                                (session) => session.weekday === n,
                              ).length
                            }{" "}
                            sessions / service hours
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              <p className="staff-help">
                {dated
                  ? "Showing the effective sessions for this date. Use Change one date for a closure, absence or different hours. Only this date changes. The weekly schedule stays unchanged."
                  : "Showing recurring weekly hours. Edit session changes that weekly rule. For leave or changed hours on one date only, choose Changes for a date and use the Dated exceptions section below."}
              </p>
              {canEdit && (
                <div className="staff-actions">
                  {!dated && (
                    <button
                      className="staff-button"
                      onClick={() => edit("sessions", newSession("", day))}
                    >
                      Add recurring session / service hours
                    </button>
                  )}
                  {dated && (
                    <button
                      className="staff-button"
                      onClick={() =>
                        edit("exceptions", {
                          id: `exception:${crypto.randomUUID()}`,
                          scopeId: "",
                          date,
                          closed: true,
                          sessions: [],
                        })
                      }
                    >
                      Change one date
                    </button>
                  )}
                </div>
              )}
              {!sessions.length && (
                <p role="status">
                  No sessions for this selection. Check the confirmed opening
                  hours and dated closures below.
                </p>
              )}
              <ul className="operational-list">
                {sessions.map((s) => (
                  <li key={`${s.scopeId}:${s.id}`}>
                    <div>
                      <h2>{professionalName(s.professionalId)}</h2>
                      <p>
                        {names(s.scopeId)} · {s.startTime}–{s.endTime} ·{" "}
                        {s.status === "cancelled" ? "Cancelled" : "Active"}
                      </p>
                      {s.professionalId && (
                        <p>
                          Patient limit: {s.capacity ?? "Not configured"}
                          {s.appointmentRequired
                            ? " · Appointment required"
                            : ""}
                        </p>
                      )}
                    </div>
                    {!dated &&
                      state.scopes.find((scope) => scope.id === s.scopeId)
                        ?.access.edit && (
                        <button
                          className="staff-button"
                          onClick={() => edit("sessions", s)}
                        >
                          Edit session
                        </button>
                      )}
                  </li>
                ))}
              </ul>
              {dated && (
                <>
                  <h2>Changes saved for {date}</h2>
                  <p className="staff-help">
                    These apply to one date and replace only that
                    clinic/service's sessions; recurring weekly hours are
                    unchanged. Edit an existing exception here, or use Change
                    one date.
                  </p>
                  {!state.exceptions.some((entry) => entry.date === date) && (
                    <p>
                      No dated changes saved for this date. Recurring sessions
                      apply.
                    </p>
                  )}
                  <ul className="operational-list">
                    {state.exceptions
                      .filter((entry) => entry.date === date)
                      .map((e) => (
                        <li key={e.id}>
                          <div>
                            <h3>{names(e.scopeId)}</h3>
                            <p>
                              {e.date} ·{" "}
                              {e.closed
                                ? "No sessions"
                                : `${e.sessions.length} replacement sessions`}
                            </p>
                          </div>
                          {state.scopes.find((s) => s.id === e.scopeId)?.access
                            .edit && (
                            <button
                              className="staff-button"
                              onClick={() => edit("exceptions", e)}
                            >
                              Edit dated exception
                            </button>
                          )}
                        </li>
                      ))}
                  </ul>
                </>
              )}
              <section className="staff-workspace-card">
                <h2>Center opening hours</h2>
                <p className="staff-help">
                  These are the center's opening times, separate from individual
                  professional sessions and Laboratory/Audiometry service hours.
                </p>
                {state.isAdmin && (
                  <button
                    className="staff-button"
                    onClick={() =>
                      edit("hours", {
                        id: "1",
                        closed: false,
                        startTime: "",
                        endTime: "",
                      })
                    }
                  >
                    Add weekday / dated opening hours
                  </button>
                )}
                <ul className="operational-list">
                  {state.hours
                    .filter((entry) =>
                      dated ? entry.id === date : entry.id === String(day),
                    )
                    .map((h) => (
                      <li key={h.id}>
                        <p>
                          {h.id.length === 1 ? WEEKDAYS[Number(h.id)] : h.id}:{" "}
                          {h.closed ? "Closed" : `${h.startTime}–${h.endTime}`}
                        </p>
                        {state.isAdmin && (
                          <button
                            className="staff-button"
                            onClick={() => edit("hours", h)}
                          >
                            Edit{" "}
                            {h.id.length === 1 ? WEEKDAYS[Number(h.id)] : h.id}{" "}
                            hours
                          </button>
                        )}
                      </li>
                    ))}
                </ul>
              </section>
            </>
          )}
          {state.isAdmin && mode === "website-updates" && (
            <section className="staff-workspace-card">
              <h2>Read-only public contract preview</h2>
              <p className="staff-help">
                Reads the local published snapshot using the existing
                directory/schedule readers. It is not the live website.
              </p>
              <div className="staff-field">
                <label htmlFor={`${id}-preview-date`}>Preview date</label>
                <input
                  id={`${id}-preview-date`}
                  type="date"
                  value={date}
                  onChange={(e) => {
                    setDate(e.target.value);
                    setPreview(null);
                  }}
                />
              </div>
              <button
                className="staff-button"
                disabled={busy || refreshing || !date}
                onClick={async () => {
                  const version = ++generation.current;
                  setError("");
                  try {
                    const result = await api.previewOperationalPublication({
                      date,
                    });
                    if (alive.current && version === generation.current)
                      setPreview(result);
                  } catch (e) {
                    failure(e);
                  }
                }}
              >
                Preview published data
              </button>
              {preview && (
                <div role="status">
                  {preview.unpublished ? (
                    "No published snapshot for this date."
                  ) : (
                    <>
                      <p>
                        {preview.schedule.centerClosed
                          ? "Center closed"
                          : `${preview.schedule.doctorSessions.length} doctors, ${preview.schedule.specialistSessions.length} specialists, ${preview.schedule.otherServices.length} services`}
                      </p>
                      <p>
                        {preview.professionals.professionals
                          .map((p) => p.name)
                          .join(" · ") || "No active public professionals"}
                      </p>
                    </>
                  )}
                </div>
              )}
            </section>
          )}
        </>
      )}
      {editor &&
        (() => {
          const Editor =
            editor.type === "exceptions" ? OneDateEditor : OperationalEditor;
          return (
            <Editor
              type={editor.type}
              initial={editor.record}
              state={state}
              onClose={() => setEditor(null)}
              onSave={(record, expectedRevision) =>
                mutate(() =>
                  api.saveOperationalRecord({
                    type: editor.type,
                    record: cleanOperationalRecord(editor.type, record),
                    expectedRevision,
                  }),
                )
              }
            />
          );
        })()}
      {publishing && (
        <OperationalPublish
          state={state}
          onReview={(payload) => api.reviewOperationalChanges(payload)}
          onClose={() => setPublishing(false)}
          onPublish={(payload) =>
            mutate(() => api.publishOperationalDrafts(payload))
          }
        />
      )}
    </section>
  );
}
