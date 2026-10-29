import { useEffect, useRef, useState } from "react";
import { PreviewDialog } from "./FormControls.jsx";
import {
  fullName,
  professionalFor,
  matchCandidates,
  REASONS,
  STATUSES,
} from "./model.js";
import { previewStore, usePreview } from "./store.js";
import NotificationPreview, { noticeLabel } from "./NotificationPreview.jsx";

function SyncBadge({ request }) {
  return (
    <span
      className={`request-status ${request.version === request.publicVersion ? "sync-current" : "sync-pending"}`}
    >
      {request.version === request.publicVersion
        ? "Tracking synchronized"
        : "Tracking update pending"}
    </span>
  );
}
export default function RequestInbox({
  role,
  assigned,
  notifications = false,
  scenario = "ready",
}) {
  const state = usePreview(),
    [status, setStatus] = useState("all"),
    [date, setDate] = useState(""),
    [query, setQuery] = useState(""),
    [page, setPage] = useState(0),
    [selected, setSelected] = useState(null),
    [noticeId, setNoticeId] = useState(null),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState("");
  const active = useRef(true),
    allowed = role === "Admin" || (role === "Receptionist" && assigned),
    actor = `Synthetic ${role}`;
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    if (!allowed) {
      setSelected(null);
      setNoticeId(null);
    }
  }, [allowed]);
  useEffect(() => {
    setPage(0);
  }, [query, status, date]);
  if (!allowed)
    return (
      <div className="staff-workspace-card">
        <h2>Clinic request access unavailable</h2>
        <p>
          Only Admin or Receptionist with the explicit clinic assignment can
          process these requests. Department text, Lab Admin and Clinic Admin
          roles do not grant this access.
        </p>
        <p className="request-muted">
          This preview illustrates the denied screen. Real server authorization
          is not implemented in Stage 1.
        </p>
      </div>
    );
  const request = state.requests.find((r) => r.id === selected);
  const results =
    scenario === "empty"
      ? []
      : state.requests.filter(
          (r) =>
            r.imported &&
            r.source !== "phone" &&
            (status === "all" || r.status === status) &&
            (!date || r.session.date === date) &&
            `${r.reference} ${fullName(r.patient)}`
              .toLowerCase()
              .includes(query.trim().toLowerCase()),
        );
  const rows = results.slice(page * 5, page * 5 + 5),
    unseen = state.requests.filter((r) => !r.imported).length;
  async function pull() {
    if (busy) return;
    setBusy(true);
    await new Promise((r) => setTimeout(r, 500));
    if (active.current) {
      if (scenario === "unavailable")
        setNotice(
          "Simulated intake connection unavailable. Existing imported requests remain visible; no new retrieval occurred.",
        );
      else {
        previewStore.pull();
        setNotice(
          "Synthetic requests refreshed. Repeated retrieval does not create extra preview rows.",
        );
      }
      setBusy(false);
    }
  }
  return (
    <>
      <div className="request-inbox-heading">
        <div>
          <p className="staff-eyebrow">ONE CLINIC · PRIVATE RECEPTION WORK</p>
          <h1 tabIndex={-1}>
            {notifications ? "Notification worklist" : "Website requests"}
          </h1>
          <p>
            {notifications
              ? "Manual WhatsApp notices and unresolved call follow-up. Opened is not delivered; sent is a staff declaration."
              : "Review patient details privately. A website request reserves no place until staff confirms."}
          </p>
        </div>
        <button
          className="staff-button staff-button-primary"
          disabled={busy}
          type="button"
          onClick={pull}
        >
          {busy ? "Refreshing…" : "Refresh requests"}
          {unseen > 0 ? ` (${unseen} new)` : ""}
        </button>
      </div>
      {notice && (
        <p className="request-alert" role="status">
          {notice}
        </p>
      )}
      <div className="request-alert">
        <strong>
          Simulated publication delivery:{" "}
          {state.syncAvailable ? "available" : "paused"}
        </strong>
        <p>
          For review only: pause delivery, confirm a request, then inspect guest
          tracking. The local decision remains confirmed while tracking retains
          its last synchronized status.
        </p>
        <button
          className="staff-button"
          type="button"
          onClick={() => previewStore.setSync(!state.syncAvailable)}
        >
          {state.syncAvailable
            ? "Pause simulated tracking sync"
            : "Resume simulated tracking sync"}
        </button>
      </div>
      {notifications ? (
        <div className="request-worklist">
          {state.notices.map((n) => {
            const r = state.requests.find((v) => v.id === n.requestId);
            return (
              <article className="staff-workspace-card" key={n.id}>
                <div className="request-tracking-top">
                  <h2>
                    {r.source === "phone"
                      ? `Phone booking ${r.bookingReference}`
                      : r.reference}
                  </h2>
                  <span className={`request-status notice-${n.status}`}>
                    {noticeLabel[n.status]}
                  </span>
                </div>
                <p>
                  {fullName(r.patient)} · {STATUSES[r.status].en} ·{" "}
                  {professionalFor(r.session).name}
                </p>
                <p>
                  <bdi dir="ltr">
                    {r.session.date} · {r.session.startTime}–{r.session.endTime}
                  </bdi>
                </p>
                {n.version !== r.version && (
                  <p className="request-error">
                    Outdated notice — retained for history, not for sending.
                  </p>
                )}
                <button
                  className="staff-button"
                  type="button"
                  onClick={() => setNoticeId(n.id)}
                >
                  {n.status === "superseded" || n.version !== r.version
                    ? "View notice history"
                    : "Send via WhatsApp"}
                </button>
              </article>
            );
          })}
        </div>
      ) : (
        <>
          <div className="request-inbox-filters">
            <label className="request-field">
              Search reference or patient
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search private inbox"
              />
            </label>
            <label className="request-field">
              Status
              <select
                aria-label="Status"
                value={status}
                onChange={(e) => setStatus(e.target.value)}
              >
                <option value="all">All statuses</option>
                {Object.entries(STATUSES).map(([key, v]) => (
                  <option key={key} value={key}>
                    {v.en}
                  </option>
                ))}
              </select>
            </label>
            <label className="request-field">
              Session date
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </label>
            <button
              className="staff-button"
              type="button"
              onClick={() => {
                setQuery("");
                setStatus("all");
                setDate("");
              }}
            >
              Clear filters
            </button>
          </div>
          {scenario === "loading" ? (
            <div className="request-card" role="status">
              Loading synthetic request inbox…
            </div>
          ) : scenario === "unavailable" ? (
            <div className="request-alert is-error" role="alert">
              <h2>Request inbox unavailable</h2>
              <p>
                Existing work is retained. Use Refresh requests after the
                connection returns.
              </p>
            </div>
          ) : rows.length === 0 ? (
            <div className="staff-workspace-card">
              <h2>No requests found</h2>
              <p>
                Adjust the filters or refresh. New requests in another preview
                tab appear after Refresh requests.
              </p>
            </div>
          ) : (
            <>
              <div className="request-inbox-table">
                <table>
                  <caption className="visually-hidden">
                    Private website requests
                  </caption>
                  <thead>
                    <tr>
                      <th>Reference / received</th>
                      <th>Patient</th>
                      <th>Session window</th>
                      <th>Status / tracking</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.id}>
                        <td>
                          <strong>{r.reference}</strong>
                          <small>
                            {new Date(r.createdAt).toLocaleDateString("en-GB")}
                          </small>
                        </td>
                        <td>
                          {fullName(r.patient)}
                          <small>
                            {r.patient.preferredLanguage === "ar"
                              ? "Arabic"
                              : "English"}
                          </small>
                        </td>
                        <td>
                          {professionalFor(r.session).name}
                          <small dir="ltr">
                            {r.session.date} · {r.session.startTime}–
                            {r.session.endTime}
                          </small>
                        </td>
                        <td>
                          <span className={`request-status status-${r.status}`}>
                            {STATUSES[r.status].en}
                          </span>
                          <SyncBadge request={r} />
                        </td>
                        <td>
                          <button
                            className="staff-button"
                            type="button"
                            onClick={() => setSelected(r.id)}
                          >
                            Review {r.reference}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="request-inbox-mobile">
                {rows.map((r) => (
                  <article key={r.id} className="staff-workspace-card">
                    <div className="request-tracking-top">
                      <strong>{r.reference}</strong>
                      <span className={`request-status status-${r.status}`}>
                        {STATUSES[r.status].en}
                      </span>
                    </div>
                    <h2>{fullName(r.patient)}</h2>
                    <p>
                      {professionalFor(r.session).name}
                      <br />
                      <bdi dir="ltr">
                        {r.session.date} · {r.session.startTime}–
                        {r.session.endTime}
                      </bdi>
                    </p>
                    <SyncBadge request={r} />
                    <button
                      className="staff-button"
                      type="button"
                      onClick={() => setSelected(r.id)}
                    >
                      Review {r.reference}
                    </button>
                  </article>
                ))}
              </div>
            </>
          )}
          <div className="request-pagination">
            <span role="status">
              {results.length} requests · Page {page + 1} of{" "}
              {Math.max(1, Math.ceil(results.length / 5))}
            </span>
            <button
              type="button"
              className="staff-button"
              disabled={page === 0}
              onClick={() => setPage(page - 1)}
            >
              Previous
            </button>
            <button
              type="button"
              className="staff-button"
              disabled={(page + 1) * 5 >= results.length}
              onClick={() => setPage(page + 1)}
            >
              Next
            </button>
          </div>
        </>
      )}
      {request && (
        <RequestDetail
          request={request}
          actor={actor}
          onClose={() => setSelected(null)}
          onNotice={(id) => setNoticeId(id)}
        />
      )}
      {noticeId && (
        <NotificationPreview
          noticeId={noticeId}
          actor={actor}
          onClose={() => setNoticeId(null)}
        />
      )}
    </>
  );
}
function RequestDetail({ request, actor, onClose, onNotice }) {
  const state = usePreview(),
    [notes, setNotes] = useState(request.notes),
    [noteSaved, setNoteSaved] = useState(false),
    [candidate, setCandidate] = useState(""),
    [ack, setAck] = useState(false),
    [discrepancy, setDiscrepancy] = useState(""),
    [create, setCreate] = useState(false),
    [reason, setReason] = useState(""),
    [action, setAction] = useState(""),
    [error, setError] = useState(""),
    [availability, setAvailability] = useState("available"),
    [reconcile, setReconcile] = useState(false);
  const candidates = matchCandidates(request.patient),
    selected = candidates.find((p) => p.id === candidate),
    currentNotices = state.notices.filter((n) => n.requestId === request.id),
    p = request.patient;
  function link() {
    if (
      !candidate ||
      !ack ||
      (selected.dateOfBirth !== p.dateOfBirth && !discrepancy.trim())
    )
      return;
    previewStore.patch(request.id, {
      linkedPatientId: candidate,
      matchAcknowledged: true,
      staffHistory: [
        ...request.staffHistory,
        {
          action: "Patient match reviewed and linked",
          actor,
          at: new Date().toISOString(),
          discrepancy: discrepancy.trim(),
        },
      ],
    });
  }
  function decide(status, existing) {
    try {
      if (status === "confirmed" && !existing && availability !== "available") {
        setError(
          {
            unset:
              "Patient limit is Not configured. Confirmation is blocked; no booking was created.",
            full: "This session is full. No ordinary booking place remains.",
            ended:
              "This session ended or is no longer available. No booking was created.",
            duplicate:
              "An active booking already exists for this patient and session. No second booking was created. Review the existing booking explicitly.",
          }[availability],
        );
        return;
      }
      previewStore.decide(
        request.id,
        status,
        reason,
        actor,
        request.version,
        existing,
      );
      setAction("");
      setError("");
    } catch (e) {
      setError(e.message);
    }
  }
  return (
    <PreviewDialog title={`Review ${request.reference}`} onClose={onClose}>
      <div className="request-tracking-top">
        <span className={`request-status status-${request.status}`}>
          {STATUSES[request.status].en}
        </span>
        <SyncBadge request={request} />
      </div>
      <p>
        {professionalFor(request.session).name} ·{" "}
        <bdi dir="ltr">
          {request.session.date} · {request.session.startTime}–
          {request.session.endTime}
        </bdi>{" "}
        · Asia/Beirut
      </p>
      <div className="request-alert">
        <p>
          This is a synthetic UI review. Real grants, patient matching, current
          limits, transaction/concurrency and decision delivery will be enforced
          in Stage 2. No actual patient or booking is created here.
        </p>
      </div>
      <h3>Submitted patient details · private</h3>
      <dl className="request-review-grid">
        {[
          ["First name", p.firstName],
          ["Father’s name", p.fatherName],
          ["Last name", p.lastName],
          ["Mother’s maiden name", p.motherFirstName],
          ["DOB", p.dateOfBirth],
          ["Phone · unverified", p.phone],
          ["Gender", p.gender],
          [
            "Preferred language",
            p.preferredLanguage === "ar" ? "Arabic" : "English",
          ],
        ].map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>
              <bdi>{value}</bdi>
            </dd>
          </div>
        ))}
      </dl>
      {request.status === "awaiting" && (
        <section className="request-note">
          <h3>Patient matching</h3>
          <p>
            Compare each name field and DOB. Shared phone numbers are supporting
            evidence only. Nothing is linked or overwritten automatically.
          </p>
          {request.linkedPatientId ? (
            <div className="request-alert">
              <strong>Patient details reviewed and linked</strong>
              <p>
                {request.linkedPatientId} · original registry details remain
                unchanged.
              </p>
            </div>
          ) : (
            <>
              {!candidates.length && (
                <p>No similar synthetic patient candidates.</p>
              )}
              {candidates.map((c) => (
                <label className="request-match" key={c.id}>
                  <input
                    type="radio"
                    name="preview-candidate"
                    checked={candidate === c.id}
                    onChange={() => {
                      setCandidate(c.id);
                      setAck(false);
                      setCreate(false);
                    }}
                  />
                  <span>
                    <strong>
                      {c.classification} · {c.patientNumber}
                    </strong>
                    <dl className="request-review-grid">
                      {[
                        ["First", c.firstName],
                        ["Father", c.fatherName],
                        ["Last", c.lastName],
                        ["Mother first name", c.motherFirstName],
                      ].map(([key, v]) => (
                        <div key={key}>
                          <dt>{key}</dt>
                          <dd>{v}</dd>
                        </div>
                      ))}
                    </dl>
                    <b
                      className={
                        c.dateOfBirth !== p.dateOfBirth ? "request-error" : ""
                      }
                    >
                      {c.discrepancy}
                    </b>
                  </span>
                </label>
              ))}
              {selected && (
                <>
                  <label className="request-checkbox">
                    <input
                      type="checkbox"
                      checked={ack}
                      onChange={(e) => setAck(e.target.checked)}
                    />
                    I compared all name fields and the date of birth; I intend
                    to link this existing patient.
                  </label>
                  {selected.dateOfBirth !== p.dateOfBirth && (
                    <label className="request-field">
                      Private discrepancy review
                      <textarea
                        value={discrepancy}
                        onChange={(e) => setDiscrepancy(e.target.value)}
                        maxLength={240}
                      />
                    </label>
                  )}
                  <button
                    type="button"
                    className="staff-button"
                    disabled={
                      !ack ||
                      (selected.dateOfBirth !== p.dateOfBirth &&
                        !discrepancy.trim())
                    }
                    onClick={link}
                  >
                    Link reviewed patient
                  </button>
                </>
              )}
              <button
                type="button"
                className="staff-button"
                onClick={() => {
                  setCreate(!create);
                  setAck(false);
                }}
              >
                Create a separate synthetic patient
              </button>
              {create && (
                <div className="request-note">
                  <p>
                    Similar records are not automatically merged. This preview
                    illustrates registration safeguards, not a real registry
                    save.
                  </p>
                  <label className="request-field">
                    Private reason for a separate patient
                    <textarea
                      value={discrepancy}
                      maxLength={240}
                      onChange={(e) => setDiscrepancy(e.target.value)}
                    />
                  </label>
                  <label className="request-checkbox">
                    <input
                      type="checkbox"
                      checked={ack}
                      onChange={(e) => setAck(e.target.checked)}
                    />
                    I reviewed the candidates and intend to create a distinct
                    patient.
                  </label>
                  <button
                    type="button"
                    className="staff-button"
                    disabled={!ack || !discrepancy.trim()}
                    onClick={() =>
                      previewStore.patch(request.id, {
                        linkedPatientId: "P-DEMO-NEW",
                        matchAcknowledged: true,
                        staffHistory: [
                          ...request.staffHistory,
                          {
                            action:
                              "Separate synthetic patient created after duplicate review",
                            actor,
                            at: new Date().toISOString(),
                            discrepancy,
                          },
                        ],
                      })
                    }
                  >
                    Create synthetic patient (preview)
                  </button>
                </div>
              )}
            </>
          )}
        </section>
      )}
      <section className="request-note">
        <h3>Private staff notes</h3>
        <label className="request-field">
          Notes — never shown to the guest
          <textarea
            value={notes}
            onChange={(e) => {
              setNotes(e.target.value);
              setNoteSaved(false);
            }}
            maxLength={1200}
          />
        </label>
        <button
          type="button"
          className="staff-button"
          onClick={() => {
            previewStore.patch(request.id, { notes });
            setNoteSaved(true);
          }}
        >
          Save private note
        </button>
        {noteSaved && <span role="status">Saved in preview memory only.</span>}
      </section>
      {error && (
        <div role="alert" className="request-alert is-error">
          {error}
        </div>
      )}
      {request.status === "awaiting" && (
        <>
          <label className="request-field">
            Preview confirmation result
            <select
              aria-label="Preview confirmation result"
              value={availability}
              onChange={(e) => {
                setAvailability(e.target.value);
                setError("");
              }}
            >
              <option value="available">Synthetic place available</option>
              <option value="unset">Patient limit Not configured</option>
              <option value="full">Session full</option>
              <option value="ended">Ended or unavailable session</option>
              <option value="duplicate">
                Existing booking needs reconciliation
              </option>
            </select>
          </label>
          <p className="request-muted">
            Real confirmation rechecks the current Cedar publication, dated
            session, immediate private limit and patient duplicate. Website
            submission reserves nothing.
          </p>
          <div className="request-actions">
            <button
              type="button"
              className="staff-button staff-button-primary"
              disabled={!request.linkedPatientId}
              onClick={() => decide("confirmed")}
            >
              Confirm booking (preview)
            </button>
            <button
              type="button"
              className="staff-button"
              onClick={() => {
                setAction("rejected");
                setReason("");
              }}
            >
              Reject request
            </button>
          </div>
          {availability === "duplicate" && (
            <div className="request-note">
              <p>
                Synthetic existing booking B-DEMO-099 for this same
                patient/session. No new booking will be created.
              </p>
              <label className="request-checkbox">
                <input
                  type="checkbox"
                  checked={reconcile}
                  onChange={(e) => setReconcile(e.target.checked)}
                />
                I checked the patient/session and want this request resolved by
                that existing booking.
              </label>
              <button
                className="staff-button"
                type="button"
                disabled={!reconcile || !request.linkedPatientId}
                onClick={() => decide("confirmed", "B-DEMO-099")}
              >
                Reconcile existing booking (preview)
              </button>
            </div>
          )}
        </>
      )}
      {request.status === "confirmed" && (
        <div className="request-note">
          <h3>Booking {request.bookingReference}</h3>
          <p>
            The place is confirmed locally in this simulation, independently of
            tracking synchronization. It reserves the full attendance window;
            check-in determines consultation order.
          </p>
          <button
            className="staff-button"
            type="button"
            onClick={() => {
              setAction("cancelled");
              setReason("");
            }}
          >
            Cancel linked booking
          </button>
        </div>
      )}
      {action && (
        <div className="request-note">
          <h3>
            {action === "cancelled"
              ? "Cancel booking and update request"
              : "Reject this request"}
          </h3>
          <label className="request-field">
            Patient-facing reason
            <select
              aria-label="Patient-facing reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            >
              <option value="">Choose a fixed reason</option>
              {Object.entries(REASONS).map(([key, v]) => (
                <option key={key} value={key}>
                  {v.en}
                </option>
              ))}
            </select>
          </label>
          <p className="request-muted">
            Only the fixed bilingual reason reaches tracking or the message.
            Internal cancellation notes and duplicate identities remain private.
          </p>
          <button
            className="staff-button staff-button-primary"
            type="button"
            disabled={!reason}
            onClick={() => decide(action)}
          >
            Confirm {action === "cancelled" ? "cancellation" : "rejection"}
          </button>
          <button
            className="staff-button"
            type="button"
            onClick={() => setAction("")}
          >
            Keep current status
          </button>
        </div>
      )}
      {request.version !== request.publicVersion && (
        <div className="request-alert">
          <strong>Tracking delivery pending</strong>
          <p>
            Local status: {STATUSES[request.status].en}. Last synchronized guest
            status: {STATUSES[request.publicStatus].en}. A public delivery
            failure does not undo the local booking.
          </p>
          <button
            className="staff-button"
            type="button"
            onClick={() => {
              try {
                previewStore.sync(request.id);
                setError("");
              } catch (e) {
                setError(e.message);
              }
            }}
          >
            Retry simulated status sync
          </button>
        </div>
      )}
      <h3>Manual notifications</h3>
      {currentNotices.length ? (
        currentNotices.map((n) => (
          <div className="request-notice-row" key={n.id}>
            <span>
              {noticeLabel[n.status]} · version {n.version}
            </span>
            <button
              type="button"
              className="staff-button"
              onClick={() => onNotice(n.id)}
            >
              {n.version !== request.version || n.status === "superseded"
                ? "View notice history"
                : "Send via WhatsApp"}
            </button>
          </div>
        ))
      ) : (
        <p>
          A decision creates a manual notification notice. No automatic sending.
        </p>
      )}
      <h3>Private action history</h3>
      {request.staffHistory.length ? (
        <ul>
          {request.staffHistory.map((h, i) => (
            <li key={i}>
              {h.action} · {h.actor} ·{" "}
              {new Date(h.at).toLocaleTimeString("en-GB")}
            </li>
          ))}
        </ul>
      ) : (
        <p>No staff decision yet.</p>
      )}
      <p className="request-muted">
        Tracking-link reissue is unavailable until its identity, expiry and
        recovery policy is approved. A name, reference or shared phone is not
        sufficient authority.
      </p>
    </PreviewDialog>
  );
}
