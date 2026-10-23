import { useEffect, useId, useRef, useState } from "react";
import OperationalEditor from "./OperationalEditor.jsx";
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
    [dated, setDated] = useState(false),
    [preview, setPreview] = useState(null);
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
          result.published
            ? "Published locally. Website delivery is pending; receiver acceptance has not yet been confirmed."
            : result.retryScheduled
              ? "Retry scheduled. Waiting for receiver acknowledgement."
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
    editableScopes =
      state?.scopes.filter((s) => s.access.edit && s.active) ?? [];
  const heading =
    mode === "professionals"
      ? "Professionals"
      : mode === "registry"
        ? "Clinics, services & assignments"
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
      <p className="staff-intro">
        Isolated local management and publication review. Atlas and the live
        website are unchanged. No booking, patient records or notifications.
      </p>
      {error && (
        <p className="staff-error" role="alert">
          {error}
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
        {canEdit && (
          <button
            className="staff-button staff-button-primary"
            disabled={busy || refreshing}
            type="button"
            onClick={() => setPublishing(true)}
          >
            Review publication
          </button>
        )}
      </div>
      {!state ? (
        <p role="status">
          {error
            ? "Operational data unavailable. Use Reload drafts to retry."
            : "Loading operational data…"}
        </p>
      ) : (
        <>
          <p className="staff-help">
            Draft revision {state.revision} · Published version {state.head}. No
            assigned scopes means no operational authority.
          </p>
          <PublicationDelivery
            configured={state.deliveryConfigured}
            deliveries={state.deliveries}
            busy={busy}
            refreshing={refreshing}
            onRefresh={() => load()}
            onRetry={(deliveryId) =>
              mutate(() => api.retryOperationalDelivery({ deliveryId })).catch(
                () => {},
              )
            }
          />
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
                      scopeIds: [],
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
              <div className="operational-toolbar">
                <label className="staff-checkbox">
                  <input
                    type="checkbox"
                    checked={dated}
                    onChange={(e) => setDated(e.target.checked)}
                  />
                  View a specific date (including dated exceptions)
                </label>
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
                    <>
                      <label htmlFor={`${id}-day`}>Recurring weekday</label>
                      <select
                        id={`${id}-day`}
                        value={day}
                        onChange={(e) => setDay(Number(e.target.value))}
                      >
                        {WEEKDAYS.map((name, n) => (
                          <option value={n} key={name}>
                            {name}
                          </option>
                        ))}
                      </select>
                    </>
                  )}
                </div>
              </div>
              <p className="staff-help">
                {dated
                  ? "Showing the effective sessions for this date: recurring weekly hours plus any dated replacements. To change only this date, use Add dated leave / changed hours or Edit dated exception below. Turn off View a specific date to edit recurring weekly hours."
                  : "Showing recurring weekly hours. Edit session changes that weekly rule. For leave or changed hours on one date only, turn on View a specific date and use the Dated exceptions section below."}
              </p>
              {canEdit && (
                <div className="staff-actions">
                  <button
                    className="staff-button"
                    onClick={() => edit("sessions", newSession("", day))}
                  >
                    Add recurring session / service hours
                  </button>
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
                    Add dated leave / changed hours
                  </button>
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
                          Capacity:{" "}
                          {s.capacity ?? "Unconfirmed — cannot publish"}
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
              <h2>Dated exceptions</h2>
              <p className="staff-help">
                These apply to one date and replace only that clinic/service's
                sessions; recurring weekly hours are unchanged. Edit an existing
                exception here, or use Add dated leave / changed hours to create
                one.
              </p>
              {!state.exceptions.length && <p>No dated exceptions saved.</p>}
              <ul className="operational-list">
                {state.exceptions.map((e) => (
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
              <h2>Center opening hours</h2>
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
                {state.hours.map((h) => (
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
                        Edit {h.id.length === 1 ? WEEKDAYS[Number(h.id)] : h.id}{" "}
                        hours
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
          {state.isAdmin && (
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
      {editor && (
        <OperationalEditor
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
      )}
      {publishing && (
        <OperationalPublish
          state={state}
          onClose={() => setPublishing(false)}
          onPublish={(payload) =>
            mutate(() => api.publishOperationalDrafts(payload))
          }
        />
      )}
    </section>
  );
}
