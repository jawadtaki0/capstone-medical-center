import { useEffect, useRef, useState } from "react";
import Dialog from "../components/WebsiteRequestDialog.jsx";

const personas = {
  admin: { label: "Admin", roles: ["Admin"] },
  clinic: { label: "Clinic Admin", roles: ["Clinic Admin"] },
  lab: { label: "Lab Admin", roles: ["Lab Admin"] },
  reception: { label: "Receptionist", roles: ["Receptionist"] },
  mixed: {
    label: "Clinic Admin + Receptionist",
    roles: ["Clinic Admin", "Receptionist"],
  },
};
const days = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];
const professionalSeed = [
  {
    id: "sami",
    name: "Dr. Sami Example",
    specialty: "Cardiology",
    kind: "doctor",
    gender: "male",
    active: true,
  },
  {
    id: "lina",
    name: "Lina Example",
    specialty: "Speech therapy",
    kind: "specialist",
    gender: "female",
    active: true,
  },
];
const initialRequests = [
  {
    id: "request-one",
    reference: "WR-PREVIEW-001",
    name: "Synthetic Example One",
    status: "awaiting",
    window: "29 Oct · 09:00–11:00",
  },
  {
    id: "request-two",
    reference: "WR-PREVIEW-002",
    name: "Synthetic Example Two",
    status: "awaiting",
    window: "30 Oct · 11:00–12:00",
  },
  {
    id: "request-three",
    reference: "WR-PREVIEW-003",
    name: "Synthetic Example Three",
    status: "confirmed",
    window: "29 Oct · 09:00–11:00",
  },
];
const initialMessages = [
  {
    id: "notice-one",
    title: "Cancellation message",
    reference: "B-PREVIEW-006",
    state: "pending",
    problem: false,
  },
  {
    id: "notice-two",
    title: "Confirmation message",
    reference: "B-PREVIEW-007",
    state: "opened",
    problem: true,
  },
  {
    id: "notice-three",
    title: "Confirmation message",
    reference: "B-PREVIEW-004",
    state: "sent",
    problem: false,
  },
];

function Badge({ children, problem = false, quiet = false }) {
  return (
    <span
      className={`up-badge ${problem ? "up-badge-problem" : quiet ? "up-badge-quiet" : ""}`}
    >
      {children}
    </span>
  );
}
function Button({ children, primary, ...props }) {
  return (
    <button
      type="button"
      className={`staff-button ${primary ? "staff-button-primary" : ""}`}
      {...props}
    >
      {children}
    </button>
  );
}
function Empty({ children }) {
  return (
    <div className="up-empty">
      <span aria-hidden="true">✓</span>
      <p>{children}</p>
    </div>
  );
}

export default function Preview() {
  const [persona, setPersona] = useState("admin");
  const [clinicGrant, setClinicGrant] = useState(true);
  const [labGrant, setLabGrant] = useState(true);
  const [audioGrant, setAudioGrant] = useState(false);
  const [page, setPage] = useState("today");
  const [requests, setRequests] = useState(initialRequests);
  const [messages, setMessages] = useState(initialMessages);
  const [viewedBy, setViewedBy] = useState({});
  const [modal, setModal] = useState(null);
  const [feedback, setFeedback] = useState("");
  const [professionals, setProfessionals] = useState(professionalSeed);
  const [scheduleMode, setScheduleMode] = useState("weekly");
  const [chosenDay, setChosenDay] = useState("Thursday");
  const [date, setDate] = useState("2026-10-29");
  const [affected, setAffected] = useState(false);
  const [showAffected, setShowAffected] = useState(false);
  const [unpublished, setUnpublished] = useState(2);
  const [delivery, setDelivery] = useState("delayed");
  const [requestTab, setRequestTab] = useState("requests");
  const history = requestTab === "history";
  const heading = useRef(null);
  const roles = personas[persona].roles;
  const isAdmin = roles.includes("Admin");
  const canClinicEdit =
    isAdmin || (roles.includes("Clinic Admin") && clinicGrant);
  const canProcess = isAdmin || (roles.includes("Receptionist") && clinicGrant);
  const canLab =
    isAdmin || (roles.includes("Lab Admin") && (labGrant || audioGrant));
  const canUpdate = canClinicEdit || canLab;
  const pending = canProcess
    ? requests.filter((r) => r.status === "awaiting").length
    : 0;
  const unsent = canProcess
    ? messages.filter((m) => m.state !== "sent").length
    : 0;
  const deliveryProblem = canUpdate && delivery === "delayed";
  const viewed = viewedBy[persona] ?? [];
  const titles = {
    today: "Today",
    professionals: "Professionals",
    schedules: "Schedules",
    updates: "Website updates",
    settings: "Center settings",
    requests: "Website requests",
    patients: "Patients",
    bookings: "Bookings",
    directory: "Staff Directory",
    services: "Service hours",
  };

  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, [page]);
  function navigate(next) {
    if (next === "messages") {
      setPage("requests");
      setRequestTab("messages");
    } else {
      setPage(next);
      if (next === "requests") setRequestTab("requests");
    }
    setFeedback("");
    setModal(null);
  }
  function switchPersona(value) {
    setPersona(value);
    setPage("today");
    setModal(null);
    setFeedback("");
  }
  function openActivity(event) {
    setViewedBy((old) => ({
      ...old,
      [persona]: [...new Set([...(old[persona] ?? []), event.id])],
    }));
    navigate(event.page);
    setFeedback(
      `Opened ${event.title}. Viewed is separate from resolving its action.`,
    );
  }
  const activities = [
    ...(canProcess
      ? [
          {
            id: "event-request",
            title: "New website request",
            detail: "WR-PREVIEW-001 · Clinic",
            at: "5 minutes ago",
            page: "requests",
            needs:
              requests.find((r) => r.id === "request-one")?.status ===
              "awaiting",
          },
          {
            id: "event-message",
            title: "Cancellation message not sent",
            detail: "B-PREVIEW-006 · Clinic",
            at: "12 minutes ago",
            page: "messages",
            needs:
              messages.find((m) => m.id === "notice-one")?.state !== "sent",
          },
        ]
      : []),
    ...(canUpdate
      ? [
          {
            id: "event-publication",
            title: "Website update accepted",
            detail: canClinicEdit
              ? "Clinic hours · previously accepted update"
              : "Assigned service hours · previously accepted update",
            at: "18 minutes ago",
            page: "updates",
            needs: false,
          },
          {
            id: "event-draft",
            title: "Hours draft saved",
            detail: canClinicEdit
              ? "Thursday · Clinic"
              : "Thursday · assigned service",
            at: "26 minutes ago",
            page: canClinicEdit ? "schedules" : "services",
            needs: unpublished > 0,
          },
          {
            id: "event-delivery",
            title: "Website delivery needs attention",
            detail: "Saved update remains pending delivery",
            at: "32 minutes ago",
            page: "updates",
            needs: deliveryProblem,
          },
        ]
      : []),
  ].slice(0, 3);
  const nav = [
    ["today", "Today"],
    ["patients", "Patients"],
    ...(canProcess
      ? [
          ["bookings", "Bookings"],
          ["requests", "Website requests"],
        ]
      : []),
    ...(canClinicEdit
      ? [
          ["professionals", "Professionals"],
          ["schedules", "Schedules"],
        ]
      : []),
    ...(canLab ? [["services", "Service hours"]] : []),
    ...(canUpdate ? [["updates", "Website updates"]] : []),
    ...(isAdmin
      ? [
          ["directory", "Staff Directory"],
          ["settings", "Center settings"],
        ]
      : []),
  ];
  function shortcut(label, next, detail, key = label) {
    return (
      <button
        type="button"
        className="up-shortcut"
        key={key}
        onClick={() => navigate(next)}
      >
        <span className="up-shortcut-icon" aria-hidden="true">
          ↗
        </span>
        <strong>{label}</strong>
        <small>{detail}</small>
      </button>
    );
  }
  function metric(label, value, next, detail, problem = false, action = true) {
    return (
      <button
        type="button"
        className={`up-metric ${value && action ? (problem ? "up-action-problem" : "up-action-pending") : ""}`}
        key={label}
        onClick={() => navigate(next)}
      >
        <span>{label}</span>
        <strong>{value}</strong>
        <small>{detail}</small>
      </button>
    );
  }
  const commonActions = [
    shortcut("Find/register patient", "patients", "Shared patient registry"),
  ];
  if (canProcess)
    commonActions.unshift(
      shortcut("New booking", "bookings", "Select patient → session → confirm"),
    );
  if (canProcess)
    commonActions.push(
      shortcut("Website requests", "requests", "Review before confirming"),
    );
  if (canClinicEdit)
    commonActions.push(
      shortcut("Professionals", "professionals", "Clinic profiles"),
      shortcut("Weekly schedule", "schedules", "Repeating session windows"),
      <button
        type="button"
        className="up-shortcut"
        key="date-changes"
        onClick={() => {
          setScheduleMode("date");
          navigate("schedules");
        }}
      >
        <span className="up-shortcut-icon" aria-hidden="true">
          ↗
        </span>
        <strong>Changes for a date</strong>
        <small>Leave, closures and changed hours</small>
      </button>,
    );
  if (canLab)
    commonActions.push(
      shortcut(
        "Service hours",
        "services",
        "Only explicitly assigned services",
      ),
    );
  if (isAdmin)
    commonActions.push(
      shortcut(
        "Staff Directory",
        "directory",
        "Supported account/profile controls",
      ),
      shortcut("Center settings", "settings", "Clinic and service definitions"),
    );

  return (
    <div className="up-preview">
      <a className="staff-skip-link" href="#up-main">
        Skip to content
      </a>
      <div className="up-preview-banner" role="note">
        <strong>SYNTHETIC LAYOUT PREVIEW</strong>
        <span>
          Clickable design only. No API, account, booking, publication or
          message is changed.
        </span>
      </div>
      <header className="up-header">
        <div className="up-brand">
          <span className="up-cross" aria-hidden="true">
            +
          </span>
          <div>
            <strong>Cedar Staff</strong>
            <small>A calmer view of the work that needs attention</small>
          </div>
        </div>
        <div className="up-identity">
          <small>Preview persona</small>
          <strong>{personas[persona].label}</strong>
        </div>
      </header>
      <section className="up-controls" aria-label="Synthetic preview controls">
        <label>
          Preview as
          <select
            value={persona}
            onChange={(e) => switchPersona(e.target.value)}
          >
            {Object.entries(personas).map(([key, p]) => (
              <option key={key} value={key}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <fieldset disabled={isAdmin}>
          <legend>Synthetic explicit scope grants</legend>
          <label>
            <input
              type="checkbox"
              checked={clinicGrant}
              onChange={(e) => {
                setClinicGrant(e.target.checked);
                setPage("today");
              }}
            />
            Clinic
          </label>
          <label>
            <input
              type="checkbox"
              checked={labGrant}
              onChange={(e) => {
                setLabGrant(e.target.checked);
                setPage("today");
              }}
            />
            Laboratory
          </label>
          <label>
            <input
              type="checkbox"
              checked={audioGrant}
              onChange={(e) => {
                setAudioGrant(e.target.checked);
                setPage("today");
              }}
            />
            Audiometry
          </label>
        </fieldset>
        <small>
          {isAdmin
            ? "Admin has center-wide access in this preview."
            : "Role labels and departments do not create grants. These controls are synthetic examples."}
        </small>
      </section>
      <div className="up-layout">
        <aside className="up-sidebar" aria-label="Preview staff navigation">
          <p className="staff-eyebrow">YOUR DAY</p>
          {nav.map(([key, label]) => {
            const count =
              key === "requests"
                ? pending
                : key === "updates"
                  ? unpublished
                  : 0;
            const actionPending =
              count > 0 || (key === "requests" && unsent > 0);
            return (
              <button
                type="button"
                className={`up-nav ${actionPending ? "up-nav-pending" : ""}`}
                aria-current={page === key ? "page" : undefined}
                onClick={() => navigate(key)}
                key={key}
              >
                <span>
                  {label}
                  {key === "requests" && pending === 0 && unsent > 0 && (
                    <small className="up-nav-status">
                      Messages need attention
                    </small>
                  )}
                </span>
                {count > 0 && <Badge>{count}</Badge>}
              </button>
            );
          })}
          <p className="up-sidebar-note">
            Opening a section does not clear unresolved work.
          </p>
        </aside>
        <main id="up-main" className="up-main">
          <div className="up-page-heading">
            <div>
              <p className="staff-eyebrow">
                CEDAR · SYNTHETIC THURSDAY, 29 OCTOBER
              </p>
              <h1 ref={heading} tabIndex={-1}>
                {titles[page]}
              </h1>
            </div>
            {canUpdate && page !== "updates" && (
              <button
                type="button"
                className="up-unpublished"
                onClick={() => navigate("updates")}
              >
                {unpublished
                  ? `${unpublished} unpublished changes`
                  : "No unpublished changes"}{" "}
                <span aria-hidden="true">↗</span>
              </button>
            )}
          </div>
          {feedback && (
            <p className="up-feedback" role="status">
              {feedback}
            </p>
          )}
          {page === "today" && (
            <>
              <p className="up-lead">
                Start with the work you can act on. Counts follow the preview
                role and its explicit scopes.
              </p>
              {!isAdmin && !canClinicEdit && !canProcess && !canLab && (
                <div className="up-callout">
                  <strong>No operational scope assigned</strong>
                  <p>
                    Patient search remains available. Operational work requires
                    an authorized scope grant.
                  </p>
                </div>
              )}
              <div className="up-metrics">
                {canProcess && (
                  <>
                    {metric(
                      "Requests awaiting decision",
                      pending,
                      "requests",
                      "Opening does not resolve them",
                    )}
                    {metric(
                      "Messages to send",
                      unsent,
                      "messages",
                      "Opened is not sent",
                    )}
                    {metric(
                      "Today’s bookings",
                      4,
                      "bookings",
                      "Clinic · full attendance windows",
                      false,
                      false,
                    )}
                  </>
                )}
                {canClinicEdit && (
                  <>
                    {metric(
                      "Unpublished changes",
                      unpublished,
                      "updates",
                      "Private drafts",
                    )}
                    {metric(
                      "Affected bookings",
                      affected ? 2 : 0,
                      "schedules",
                      "Only relevant conflicts appear",
                    )}
                  </>
                )}
                {canUpdate &&
                  metric(
                    "Publication-delivery problems",
                    deliveryProblem ? 1 : 0,
                    "updates",
                    "Last accepted website remains available",
                    true,
                  )}
              </div>
              <section className="up-section">
                <div className="up-section-heading">
                  <h2>Quick actions</h2>
                  <span className="up-muted">
                    Available for this role and scope
                  </span>
                </div>
                <div className="up-shortcuts">{commonActions}</div>
              </section>
              <section className="up-section">
                <div className="up-section-heading">
                  <h2>Latest activity</h2>
                  <small>Latest three relevant examples</small>
                </div>
                {activities.length ? (
                  <ul className="up-activity">
                    {activities.map((event) => (
                      <li key={event.id}>
                        <button
                          type="button"
                          onClick={() => openActivity(event)}
                        >
                          <span
                            className="up-activity-dot"
                            aria-hidden="true"
                          />
                          <span>
                            <strong>{event.title}</strong>
                            <small>
                              {event.detail} · {event.at}
                            </small>
                          </span>
                          <span className="up-activity-tags">
                            <Badge quiet>
                              {viewed.includes(event.id) ? "Viewed" : "New"}
                            </Badge>
                            <Badge quiet={!event.needs}>
                              {event.needs ? "Needs action" : "Resolved"}
                            </Badge>
                            <span aria-hidden="true">↗</span>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <Empty>No authorized operational activity to show.</Empty>
                )}
                <p className="up-note">
                  New/Viewed belongs to this synthetic persona. Needs
                  action/Resolved describes the underlying work; viewing never
                  resolves it.
                </p>
              </section>
            </>
          )}
          {page === "professionals" && (
            <section className="up-section">
              <div className="up-section-heading">
                <div>
                  <h2>Clinic professionals</h2>
                  <p>
                    ONE clinic · profiles remain separate from staff login
                    accounts.
                  </p>
                </div>
                <Button
                  primary
                  onClick={() =>
                    setModal({
                      type: "professional",
                      record: {
                        name: "",
                        specialty: "",
                        kind: "doctor",
                        gender: "neutral",
                        active: true,
                      },
                    })
                  }
                >
                  Add professional
                </Button>
              </div>
              <label className="up-search">
                Search professionals
                <input
                  type="search"
                  placeholder="⌕ Name or specialty"
                  onChange={(e) =>
                    setFeedback(
                      e.target.value
                        ? "Search field preview — all examples remain visible."
                        : "",
                    )
                  }
                />
              </label>
              <div className="up-list">
                {professionals.map((p) => (
                  <article key={p.id} className="up-record">
                    <div className="up-avatar" aria-hidden="true">
                      {p.name
                        .split(" ")
                        .slice(-2)
                        .map((n) => n[0])
                        .join("")}
                    </div>
                    <div>
                      <h3>{p.name}</h3>
                      <p>
                        {p.specialty} ·{" "}
                        {p.kind === "doctor" ? "Doctor" : "Specialist"}
                      </p>
                      <small>Clinic · Gender determines avatar</small>
                    </div>
                    <Badge quiet>{p.active ? "Active" : "Inactive"}</Badge>
                    <Button
                      onClick={() =>
                        setModal({ type: "professional", record: p })
                      }
                    >
                      Edit profile
                    </Button>
                  </article>
                ))}
              </div>
              <div className="up-preview-option">
                <label>
                  <input
                    type="checkbox"
                    checked={affected}
                    onChange={(e) => {
                      setAffected(e.target.checked);
                      if (!e.target.checked) setShowAffected(false);
                    }}
                  />
                  Show an example with affected bookings
                </label>
              </div>
              {affected && (
                <div className="up-callout">
                  <strong>
                    2 bookings need review before an incompatible update
                  </strong>
                  <p>Nothing is moved or cancelled automatically.</p>
                  <Button onClick={() => setShowAffected((v) => !v)}>
                    {showAffected
                      ? "Close affected bookings"
                      : "Review affected bookings"}
                  </Button>
                  {showAffected && (
                    <ul>
                      <li>B-PREVIEW-011 · 29 Oct · 09:00–11:00</li>
                      <li>B-PREVIEW-012 · 29 Oct · 09:00–11:00</li>
                    </ul>
                  )}
                </div>
              )}
            </section>
          )}
          {page === "schedules" && (
            <>
              <div className="up-tabs" role="group" aria-label="Schedule mode">
                <button
                  type="button"
                  aria-pressed={scheduleMode === "weekly"}
                  onClick={() => setScheduleMode("weekly")}
                >
                  Weekly schedule
                </button>
                <button
                  type="button"
                  aria-pressed={scheduleMode === "date"}
                  onClick={() => setScheduleMode("date")}
                >
                  Changes for a date
                </button>
              </div>
              {scheduleMode === "weekly" ? (
                <section className="up-section">
                  <div className="up-section-heading">
                    <div>
                      <h2>Repeating weekly hours</h2>
                      <p>
                        Choose a weekday. A weekly change repeats until
                        superseded.
                      </p>
                    </div>
                    <Button
                      primary
                      onClick={() => setModal({ type: "session" })}
                    >
                      Add session
                    </Button>
                  </div>
                  <div className="up-weekdays" aria-label="Choose weekday">
                    {days.map((day) => (
                      <button
                        type="button"
                        aria-pressed={chosenDay === day}
                        onClick={() => setChosenDay(day)}
                        key={day}
                      >
                        <small>{day.slice(0, 3)}</small>
                        <strong>
                          {day === "Sunday"
                            ? "Closed"
                            : day === "Thursday"
                              ? "2 sessions"
                              : "1 session"}
                        </strong>
                      </button>
                    ))}
                  </div>
                  <div className="up-hours-row">
                    <span>
                      <strong>Center opening hours · {chosenDay}</strong>
                      <small>
                        Separate from professional attendance windows
                      </small>
                    </span>
                    <strong>
                      {chosenDay === "Sunday" ? "Closed" : "08:00–17:00"}
                    </strong>
                    <Button onClick={() => setModal({ type: "hours" })}>
                      Edit opening hours
                    </Button>
                  </div>
                  {chosenDay !== "Sunday" ? (
                    <div className="up-session-row">
                      <span>
                        <strong>Dr. Sami Example</strong>
                        <small>Cardiology · full session window</small>
                      </span>
                      <strong>09:00–11:00</strong>
                      <span>
                        <small>Patient limit</small>
                        <strong>3 · manual</strong>
                      </span>
                      <Button onClick={() => setModal({ type: "session" })}>
                        Edit session
                      </Button>
                    </div>
                  ) : (
                    <Empty>
                      No professional sessions in this synthetic Sunday.
                    </Empty>
                  )}
                  <p className="up-note">
                    Hours and specialty edits do not recalculate patient limits.
                    Not configured is not unlimited.
                  </p>
                </section>
              ) : (
                <section className="up-section">
                  <div className="up-section-heading">
                    <div>
                      <h2>Changes for one date</h2>
                      <p>
                        Leave, a holiday or changed hours on a specific date.
                        Weekly hours remain separate.
                      </p>
                    </div>
                    <Button
                      primary
                      onClick={() => setModal({ type: "exception" })}
                    >
                      Add date change
                    </Button>
                  </div>
                  <label className="up-date">
                    Date
                    <input
                      type="date"
                      value={date}
                      onChange={(e) => setDate(e.target.value)}
                    />
                  </label>
                  <div className="up-calendar-summary">
                    <span className="up-date-tile">
                      <small>SELECTED DATE</small>
                      <strong>{date || "Choose date"}</strong>
                    </span>
                    <div>
                      <h3>Clinic · one-date change</h3>
                      <p>
                        No date-specific change saved in this example. The
                        weekly schedule applies.
                      </p>
                      <Button onClick={() => setModal({ type: "exception" })}>
                        Change this date
                      </Button>
                    </div>
                  </div>
                  <div className="up-hours-row">
                    <span>
                      <strong>Center opening hours</strong>
                      <small>
                        For this date, including an explicit holiday closure
                      </small>
                    </span>
                    <strong>08:00–17:00</strong>
                    <Button onClick={() => setModal({ type: "hours" })}>
                      Edit date hours
                    </Button>
                  </div>
                  <div className="up-session-row">
                    <span>
                      <strong>Professional sessions</strong>
                      <small>Dr. Sami Example · weekly baseline</small>
                    </span>
                    <strong>09:00–11:00</strong>
                    <Badge quiet>Weekly hours apply</Badge>
                  </div>
                </section>
              )}
            </>
          )}
          {page === "updates" && (
            <section className="up-section">
              <div className="up-section-heading">
                <div>
                  <h2>Review & update website</h2>
                  <p>
                    Only the accepted public version reaches the website. Drafts
                    stay private.
                  </p>
                </div>
                <Badge quiet={!unpublished}>
                  {unpublished
                    ? `${unpublished} unpublished changes`
                    : "No unpublished changes"}
                </Badge>
              </div>
              <div
                className={`up-update-state ${delivery === "delayed" ? "up-action-problem" : ""}`}
              >
                <strong>
                  {delivery === "delayed"
                    ? "! Delivery delayed"
                    : delivery === "updating"
                      ? "Loading… Updating website"
                      : "✓ Website updated"}
                </strong>
                <p>
                  {delivery === "delayed"
                    ? "The last accepted website is still available. Review the saved update and retry delivery."
                    : delivery === "updating"
                      ? "Local save is complete. Waiting for the public receiver — not yet shown as updated."
                      : "This preview simulated receiver acceptance. Effective-date rules still apply."}
                </p>
              </div>
              <ul className="up-change-summary">
                <li>
                  <strong>
                    {canClinicEdit ? "Professional profile" : "Service hours"}
                  </strong>
                  <span>
                    {canClinicEdit
                      ? "Specialty text updated · Clinic"
                      : "Thursday hours reviewed · assigned service"}
                  </span>
                </li>
                <li>
                  <strong>Thursday hours</strong>
                  <span>
                    {canClinicEdit
                      ? "One session window reviewed · Clinic"
                      : "One-date service closure reviewed"}
                  </span>
                </li>
              </ul>
              <div className="up-actions">
                <Button
                  primary
                  onClick={() => setModal({ type: "publication" })}
                >
                  Review & update website
                </Button>
                {delivery === "updating" && (
                  <Button
                    onClick={() => {
                      setDelivery("accepted");
                      setUnpublished(0);
                      setFeedback(
                        "Preview only: receiver acceptance simulated. No actual publication was created.",
                      );
                    }}
                  >
                    Simulate receiver acceptance
                  </Button>
                )}
              </div>
              <details className="up-technical">
                <summary>Technical details</summary>
                <dl>
                  <dt>Source</dt>
                  <dd>Synthetic draft/version examples only</dd>
                  <dt>Last accepted version</dt>
                  <dd>PREVIEW-001</dd>
                  <dt>Effective from</dt>
                  <dd>Undated baseline · example</dd>
                  <dt>Delivery</dt>
                  <dd>{delivery}</dd>
                </dl>
                <p>
                  Real versions, digests and receiver acknowledgements will stay
                  here. No live configuration is loaded.
                </p>
              </details>
            </section>
          )}
          {page === "settings" && (
            <section className="up-section">
              <div className="up-section-heading">
                <div>
                  <h2>Clinic & service definitions</h2>
                  <p>Configuration is separate from staff authority.</p>
                </div>
              </div>
              <div className="up-definition-list">
                {["Clinic", "Laboratory", "Audiometry"].map((name, i) => (
                  <article key={name}>
                    <span className="up-definition-icon" aria-hidden="true">
                      {i === 0 ? "+" : "◷"}
                    </span>
                    <div>
                      <h3>{name}</h3>
                      <p>
                        {i === 0
                          ? "The center’s one clinic"
                          : "Separate service — not a clinic booking"}
                      </p>
                    </div>
                    <Badge quiet>Active</Badge>
                    <Button
                      onClick={() => setModal({ type: "definition", name })}
                    >
                      Edit definition
                    </Button>
                  </article>
                ))}
              </div>
              <div className="up-settings-access">
                <div>
                  <h3>Staff access</h3>
                  <p>
                    Roles and explicit service/clinic grants belong in
                    authorized staff management.
                  </p>
                </div>
                <Button onClick={() => navigate("directory")}>
                  Manage staff access ↗
                </Button>
              </div>
              <p className="up-note">
                Audiometry responsibility is configurable. A service definition
                does not grant access.
              </p>
            </section>
          )}
          {page === "services" && (
            <section className="up-section">
              <div className="up-section-heading">
                <div>
                  <h2>Assigned service hours</h2>
                  <p>
                    Lab Admin sees only explicitly assigned services. No lab
                    order, PDF or clinical workflow is shown.
                  </p>
                </div>
              </div>
              {[
                ...(isAdmin || labGrant ? ["Laboratory"] : []),
                ...(isAdmin || audioGrant ? ["Audiometry"] : []),
              ].map((name) => (
                <div className="up-hours-row" key={name}>
                  <span>
                    <strong>{name}</strong>
                    <small>Thursday · service-only hours</small>
                  </span>
                  <strong>08:00–15:00</strong>
                  <Button onClick={() => setModal({ type: "hours", name })}>
                    Edit service hours
                  </Button>
                </div>
              ))}
              <div className="up-actions">
                <Button onClick={() => navigate("updates")}>
                  Review & update website
                </Button>
              </div>
            </section>
          )}
          {page === "requests" && canProcess && (
            <div
              className="up-tabs up-request-tabs"
              role="group"
              aria-label="Website request views"
            >
              <button
                type="button"
                aria-pressed={requestTab === "requests"}
                onClick={() => setRequestTab("requests")}
              >
                Requests{pending > 0 && <Badge>{pending}</Badge>}
              </button>
              <button
                type="button"
                aria-pressed={requestTab === "messages"}
                onClick={() => setRequestTab("messages")}
              >
                Messages to send{unsent > 0 && <Badge>{unsent}</Badge>}
              </button>
              <button
                type="button"
                aria-pressed={requestTab === "history"}
                onClick={() => setRequestTab("history")}
              >
                History
              </button>
            </div>
          )}
          {page === "requests" && requestTab === "requests" && (
            <section className="up-section">
              <div className="up-section-heading">
                <div>
                  <h2>Requests</h2>
                  <p>
                    Suggestions do not decide identity. No patient is created by
                    opening a request.
                  </p>
                </div>
                <Badge>{pending} awaiting decision</Badge>
              </div>
              <div className="up-list">
                {requests.map((r) => (
                  <article
                    className={`up-request-row ${r.status === "awaiting" ? "up-action-pending" : ""}`}
                    key={r.id}
                  >
                    <span>
                      <strong>{r.reference}</strong>
                      <small>
                        {r.name} · {r.window}
                      </small>
                    </span>
                    <Badge quiet={r.status !== "awaiting"}>
                      {r.status === "awaiting"
                        ? "Awaiting decision"
                        : "Confirmed"}
                    </Badge>
                    <Button
                      onClick={() => setModal({ type: "request", record: r })}
                    >
                      Review request
                    </Button>
                  </article>
                ))}
              </div>
            </section>
          )}
          {page === "requests" && requestTab !== "requests" && (
            <section className="up-section">
              <div className="up-section-heading">
                <div>
                  <h2>{history ? "Message history" : "Messages to send"}</h2>
                  <p>
                    Opening WhatsApp is not delivery. Sent history remains
                    separate.
                  </p>
                </div>
              </div>
              {messages
                .filter((m) =>
                  history ? m.state === "sent" : m.state !== "sent",
                )
                .map((m) => (
                  <article
                    className={`up-request-row ${m.problem && m.state !== "sent" ? "up-action-problem" : m.state !== "sent" ? "up-action-pending" : ""}`}
                    key={m.id}
                  >
                    <span>
                      <strong>{m.title}</strong>
                      <small>
                        {m.reference} ·{" "}
                        {m.state === "opened"
                          ? "WhatsApp link opened — not marked sent"
                          : m.state === "sent"
                            ? "Staff marked sent"
                            : "Pending manual WhatsApp"}
                      </small>
                    </span>
                    <Badge
                      problem={m.problem && m.state !== "sent"}
                      quiet={m.state === "sent"}
                    >
                      {m.state === "sent"
                        ? "Resolved"
                        : m.problem
                          ? "Delivery problem"
                          : "Message not sent"}
                    </Badge>
                    <Button
                      onClick={() => setModal({ type: "notice", record: m })}
                    >
                      {m.state === "sent" ? "View history" : "Review message"}
                    </Button>
                  </article>
                ))}
              {!messages.some((m) =>
                history ? m.state === "sent" : m.state !== "sent",
              ) && (
                <Empty>
                  {history
                    ? "No sent examples yet."
                    : "No unresolved messages in this preview."}
                </Empty>
              )}
            </section>
          )}
          {page === "bookings" && (
            <section className="up-section">
              <div className="up-section-heading">
                <div>
                  <h2>Clinic bookings</h2>
                  <p>
                    Select/register patient → choose session → confirm. Full
                    window, not an exact consultation time.
                  </p>
                </div>
                <Button primary onClick={() => setModal({ type: "booking" })}>
                  New booking
                </Button>
              </div>
              <article className="up-record">
                <div>
                  <h3>B-PREVIEW-007 · Synthetic Example Patient</h3>
                  <p>29 Oct · Dr. Sami Example · 09:00–11:00</p>
                  <small>
                    Staff/phone booking · no website request required
                  </small>
                </div>
                <Badge quiet>Confirmed</Badge>
                <Button
                  onClick={() =>
                    setModal({ type: "notice", record: messages[1] })
                  }
                >
                  Send via WhatsApp
                </Button>
                <Button onClick={() => setModal({ type: "cancel" })}>
                  Cancel booking
                </Button>
              </article>
              <p className="up-note">
                If messaging configuration is unavailable, a clear reason will
                appear instead of silently hiding the action.
              </p>
            </section>
          )}
          {page === "patients" && (
            <section className="up-section">
              <h2>Find/register patient</h2>
              <p className="up-lead">
                This shortcut opens the existing shared registry. Preview only:
                no patient records are queried or saved.
              </p>
              <label className="up-search">
                Search patients
                <input type="search" placeholder="Patient number or name" />
              </label>
              <Button onClick={() => setModal({ type: "patient" })}>
                Register patient
              </Button>
            </section>
          )}
          {page === "directory" && (
            <section className="up-section">
              <h2>Staff Directory & access</h2>
              <p className="up-lead">
                Existing permission-checked staff workflows remain here. Roles
                and explicit scope assignments are separate from center
                definitions.
              </p>
              <article className="up-record">
                <div>
                  <h3>Synthetic Receptionist</h3>
                  <p>Receptionist · descriptive department: Administration</p>
                  <small>Explicit scope: Clinic</small>
                </div>
                <Button onClick={() => setModal({ type: "access" })}>
                  Review staff access
                </Button>
              </article>
            </section>
          )}
        </main>
      </div>
      {modal && (
        <Dialog
          title={
            modal.type === "professional"
              ? "Professional profile draft"
              : modal.type === "publication"
                ? "Review website update"
                : modal.type === "request"
                  ? "Review request"
                  : modal.type === "notice"
                    ? "Manual WhatsApp message"
                    : modal.type === "session"
                      ? "Weekly professional session"
                      : modal.type === "exception"
                        ? "Change one date"
                        : modal.type === "hours"
                          ? "Opening hours"
                          : "Preview action"
          }
          onClose={() => setModal(null)}
        >
          <p className="up-modal-note">
            Synthetic layout interaction only. Nothing is saved outside this
            page.
          </p>
          {modal.type === "professional" ? (
            <ProfessionalEditor
              initial={modal.record}
              onSave={(record) => {
                setProfessionals((old) =>
                  record.id
                    ? old.map((p) => (p.id === record.id ? record : p))
                    : [...old, { ...record, id: "preview-" + old.length }],
                );
                setUnpublished((v) => v + 1);
                setModal(null);
                setFeedback(
                  "Private draft changed in preview memory. The website was not updated.",
                );
              }}
              onCancel={() => setModal(null)}
            />
          ) : modal.type === "publication" ? (
            <>
              <p className="up-lead">
                Review two private changes before sending public information.
              </p>
              <ul className="up-change-summary">
                <li>
                  <strong>
                    {canClinicEdit
                      ? "Clinic professional"
                      : "Assigned service hours"}
                  </strong>
                  <span>
                    {canClinicEdit
                      ? "Specialty wording changed"
                      : "Thursday hours changed"}
                  </span>
                </li>
                <li>
                  <strong>
                    {canClinicEdit
                      ? "Thursday session"
                      : "One-date service change"}
                  </strong>
                  <span>
                    {canClinicEdit
                      ? "Attendance window reviewed; manual limit preserved"
                      : "Explicit closure reviewed; no professional session"}
                  </span>
                </li>
              </ul>
              <p>
                No patient, private limit, staff or request information is
                included. All affected scopes still require publication
                authority.
              </p>
              <label className="up-field">
                Effective from
                <select>
                  <option>Undated baseline — preview</option>
                  <option>Selected future date — preview</option>
                </select>
              </label>
              <div className="up-actions">
                <Button
                  primary
                  onClick={() => {
                    setDelivery("updating");
                    setModal(null);
                    setFeedback(
                      "Preview only: local save simulated. Website updated awaits simulated receiver acceptance.",
                    );
                  }}
                >
                  Confirm update — preview
                </Button>
                <Button onClick={() => setModal(null)}>Cancel</Button>
              </div>
            </>
          ) : modal.type === "request" ? (
            <>
              <p>
                <strong>{modal.record.reference}</strong> · {modal.record.name}
              </p>
              <div className="up-callout">
                <strong>No patient candidates in this synthetic example</strong>
                <p>
                  At confirmation, the server will recheck and create/link only
                  if still clear, in the same guarded operation as booking. A
                  new candidate stops automatic creation.
                </p>
              </div>
              <p>
                Opening this dialog has not created a patient. Existing matches
                remain staff decisions; straightforward matching does not need
                an arbitrary reason.
              </p>
              <div className="up-actions">
                <Button
                  primary
                  disabled={modal.record.status !== "awaiting"}
                  onClick={() => {
                    setRequests((old) =>
                      old.map((r) =>
                        r.id === modal.record.id
                          ? { ...r, status: "confirmed" }
                          : r,
                      ),
                    );
                    setModal(null);
                    setFeedback(
                      "Preview only: request resolved in browser memory. No patient or booking created.",
                    );
                  }}
                >
                  Simulate confirmation
                </Button>
                <Button onClick={() => setModal(null)}>Close</Button>
              </div>
            </>
          ) : modal.type === "notice" ? (
            <>
              <p>
                <strong>{modal.record?.title}</strong> ·{" "}
                {modal.record?.reference}
              </p>
              <p>
                Cedar Medical Center CMC
                <br />
                Name: Synthetic Example Patient
                <br />
                Dr: Sami Example
                <br />
                29 October · 09:00–11:00
                <br />
                <strong>
                  {modal.record?.title === "Cancellation message"
                    ? "CANCELLED"
                    : "CONFIRMED"}
                </strong>
              </p>
              <p>
                {modal.record?.title === "Cancellation message"
                  ? "Other — please call the center"
                  : "This is your attendance window. Consultation order follows check-in. Please report to reception on arrival."}
              </p>
              <p>
                Center contact: SYNTHETIC CONTACT
                <br />
                [Private link omitted in this preview]
              </p>
              <p className="up-note">
                Real opening uses the server-authorized destination and
                fixed-host Electron bridge. This preview never opens WhatsApp.
              </p>
              <div className="up-actions">
                <Button disabled>
                  Send via WhatsApp — unavailable in preview
                </Button>
                {modal.record?.state !== "sent" && (
                  <Button
                    primary
                    onClick={() => {
                      setMessages((old) =>
                        old.map((m) =>
                          m.id === modal.record.id
                            ? { ...m, state: "sent", problem: false }
                            : m,
                        ),
                      );
                      setModal(null);
                      setFeedback(
                        "Preview only: unresolved-message highlight cleared. No real message was sent.",
                      );
                    }}
                  >
                    Simulate staff-marked sent
                  </Button>
                )}
                <Button onClick={() => setModal(null)}>Close</Button>
              </div>
            </>
          ) : ["session", "exception", "hours"].includes(modal.type) ? (
            <ScheduleEditor
              type={modal.type}
              date={date}
              service={modal.name}
              onCancel={() => setModal(null)}
              onSave={() => {
                setUnpublished((v) => v + 1);
                setModal(null);
                setFeedback(
                  "Private schedule draft changed in preview memory. No publication or booking changed.",
                );
              }}
            />
          ) : (
            <>
              <p>
                This opens an existing supported workflow in the final app. This
                layout preview does not modify data, account access or messaging
                configuration.
              </p>
              <Button onClick={() => setModal(null)}>Close</Button>
            </>
          )}
        </Dialog>
      )}
    </div>
  );
}

function ProfessionalEditor({ initial, onSave, onCancel }) {
  const [record, setRecord] = useState(initial);
  const update = (key, value) => setRecord((old) => ({ ...old, [key]: value }));
  return (
    <form
      className="up-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(record);
      }}
    >
      <div className="up-form-grid">
        <label>
          Professional kind
          <select
            value={record.kind}
            disabled={Boolean(record.id)}
            onChange={(e) => update("kind", e.target.value)}
          >
            <option value="doctor">Doctor</option>
            <option value="specialist">Specialist (not a doctor)</option>
          </select>
        </label>
        <label>
          Professional name and actual title
          <input
            required
            maxLength={160}
            value={record.name}
            onChange={(e) => update("name", e.target.value)}
          />
        </label>
        <label>
          Specialty
          <input
            required
            maxLength={160}
            value={record.specialty}
            onChange={(e) => update("specialty", e.target.value)}
          />
        </label>
        <label>
          Gender
          <select
            value={record.gender}
            onChange={(e) => update("gender", e.target.value)}
          >
            <option value="neutral">Unconfirmed — draft only</option>
            <option value="male">Male — confirmed</option>
            <option value="female">Female — confirmed</option>
          </select>
        </label>
      </div>
      <div className="up-readonly">
        <strong>Clinic</strong>
        <p>The center’s one clinic. No independent clinic selector.</p>
        <small>
          The real server must resolve exactly one active clinic and fail
          clearly otherwise. This is a layout proposal, not a server change.
        </small>
      </div>
      <label className="up-check">
        <input
          type="checkbox"
          checked={record.active}
          onChange={(e) => update("active", e.target.checked)}
        />
        Active — deactivate without deleting history
      </label>
      <p className="up-note">
        Gender determines the avatar. Unconfirmed gender can stay a draft but
        cannot publish. Deactivation/publication safeguards remain in force.
      </p>
      <div className="up-actions">
        <button className="staff-button staff-button-primary" type="submit">
          Save draft — preview
        </button>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}
function ScheduleEditor({ type, date, service, onSave, onCancel }) {
  const [limit, setLimit] = useState("3");
  const isService = Boolean(service);
  return (
    <form
      className="up-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSave();
      }}
    >
      <div className="up-form-grid">
        {type === "exception" ? (
          <label>
            Date
            <input type="date" required defaultValue={date} />
          </label>
        ) : (
          <label>
            Weekday
            <select defaultValue="Thursday">
              {days.map((day) => (
                <option key={day}>{day}</option>
              ))}
            </select>
          </label>
        )}
        {type !== "hours" && (
          <label>
            Professional
            <select>
              <option>Dr. Sami Example</option>
              <option>Lina Example</option>
            </select>
          </label>
        )}
        <label>
          Start
          <input type="time" required defaultValue="09:00" />
        </label>
        <label>
          End
          <input type="time" required defaultValue="11:00" />
        </label>
        {type !== "hours" && (
          <label>
            Patient limit
            <input
              type="number"
              min="1"
              step="1"
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              placeholder="Not configured"
            />
            <small>
              Blank = Not configured. Manual, never calculated from duration.
            </small>
          </label>
        )}
      </div>
      {type === "exception" && (
        <label className="up-check">
          <input type="checkbox" />
          Closed for this date
        </label>
      )}
      {type === "hours" && (
        <label className="up-check">
          <input type="checkbox" />
          Center/service closed
        </label>
      )}
      <p className="up-note">
        {isService
          ? service +
            " service-only hours have no professional or bookable session."
          : type === "hours"
            ? "Opening hours describe the center. Professional sessions are separate."
            : "Full-session windows, adjacent times allowed, overlap and existing-booking protection remain. A one-date replacement is explicit and does not silently inherit or change limits."}
      </p>
      <div className="up-actions">
        <button type="submit" className="staff-button staff-button-primary">
          Save draft — preview
        </button>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}
