import { useEffect, useRef, useState } from "react";
import PreviewDialog from "./WebsiteRequestDialog.jsx";
import { REQUEST_REASONS } from "../../../../shared/website-request-contract.mjs";
import "../website-requests.css";

const names = {
  awaiting: "Awaiting confirmation",
  confirmed: "Confirmed",
  rejected: "Rejected",
  cancelled: "Cancelled",
};
const noticeNames = {
  pending: "Pending",
  opened: "WhatsApp link opened",
  sent: "Staff marked sent",
  call_required: "Call required",
  call_recorded: "Recorded call outcome",
  superseded: "Superseded",
};
const fullName = (p) =>
  [p?.firstName, p?.fatherName, p?.lastName].filter(Boolean).join(" ");
function key() {
  return btoa(
    String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))),
  )
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
export default function WebsiteRequests({ api, onError }) {
  const [rows, setRows] = useState([]),
    [view, setView] = useState("requests"),
    [cursor, setCursor] = useState(null),
    [page, setPage] = useState(0),
    [next, setNext] = useState(null),
    [noticeState, setNoticeState] = useState(""),
    [status, setStatus] = useState(""),
    [date, setDate] = useState(""),
    [query, setQuery] = useState(""),
    [error, setError] = useState(""),
    [feedback, setFeedback] = useState(""),
    [busy, setBusy] = useState(false),
    [detail, setDetail] = useState(null),
    [notice, setNotice] = useState(null),
    [noticeId, setNoticeId] = useState(null),
    [language, setLanguage] = useState("en"),
    [ack, setAck] = useState(false),
    [sentAck, setSentAck] = useState(false),
    [reason, setReason] = useState(""),
    [notes, setNotes] = useState(""),
    [selected, setSelected] = useState(""),
    [review, setReview] = useState(null),
    [decision, setDecision] = useState(""),
    [rotationKey, setRotationKey] = useState(null);
  const generation = useRef(0),
    pending = useRef(false),
    alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      generation.current++;
    };
  }, []);
  async function run(action, body = {}) {
    if (pending.current) return null;
    const g = generation.current;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const r = await api.websiteRequests({ action, ...body });
      return alive.current && g === generation.current ? r : null;
    } catch (e) {
      if (alive.current && g === generation.current) {
        setError(e.message);
        if (e.code === "request_forbidden") {
          setDetail(null);
          setNotice(null);
          setRows([]);
        }
        onError?.(e);
      }
      return null;
    } finally {
      pending.current = false;
      if (alive.current) setBusy(false);
    }
  }
  async function load(c = null) {
    const r = await run(view === "requests" ? "list" : "notices", {
      ...(view === "requests"
        ? {
            ...(status ? { status } : {}),
            ...(date ? { date } : {}),
            ...(query ? { query } : {}),
          }
        : { state: noticeState }),
      ...(c !== null ? { cursor: c } : {}),
    });
    if (r) {
      setRows(r.requests ?? r.notices);
      setNext(r.nextCursor);
      setCursor(c);
    }
  }
  useEffect(() => {
    setPage(0);
    const timer = setTimeout(() => {
      void load();
    }, 0);
    return () => clearTimeout(timer);
  }, [view, status, date, noticeState]);
  function close() {
    generation.current++;
    setDetail(null);
    setNotice(null);
    setNoticeId(null);
    setReview(null);
    setDecision("");
    setAck(false);
    setReason("");
    setNotes("");
    setRotationKey(null);
    setError("");
  }
  async function open(id) {
    const r = await run("detail", { id });
    if (r) {
      setDetail(r);
      setNotes(r.request.notes ?? "");
      setSelected("");
      setAck(false);
      setReason("");
      setReview(null);
      setDecision("");
    }
  }
  async function change(action, body = {}) {
    const id = detail.request.id,
      r = await run(action, { id, revision: detail.request.revision, ...body });
    if (r) {
      if (r.reviewRequired) {
        setDetail((d) => ({ ...d, matches: r }));
        setFeedback(
          "Registry changed. Review the refreshed candidates before creating.",
        );
      } else {
        await open(id);
        setFeedback(
          r.rotated
            ? "Tracking link replaced. The old link is invalid. Manual WhatsApp delivery to the original unverified phone is still pending."
            : "Request saved.",
        );
        void load(cursor);
      }
    }
  }
  async function openNotice(id) {
    const r = await run("notification", {
      noticeId: id,
      noticeAction: "preview",
      language,
    });
    if (r) {
      setNoticeId(id);
      setNotice(r);
      setAck(false);
      setSentAck(false);
      setReason("");
    }
  }
  async function noticeAction(action, body = {}) {
    const r = await run("notification", {
      noticeId,
      noticeAction: action,
      language,
      ...body,
    });
    if (r) await openNotice(noticeId);
  }
  async function openWhatsApp() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      await api.websiteRequests({
        action: "notification",
        noticeAction: "configure",
        noticeId,
        language,
        contactAcknowledged: ack,
      });
      const result = await api.openRequestWhatsApp({ noticeId });
      setFeedback(
        result.warning ??
          "WhatsApp link opened. This is not delivery; mark sent only after manually sending.",
      );
    } catch (e) {
      setError(e.message);
    } finally {
      pending.current = false;
      setBusy(false);
    }
    await openNotice(noticeId);
  }
  const r = detail?.request;
  return (
    <div className="cedar-preview">
      <div className="request-inbox-heading">
        <div>
          <p className="staff-eyebrow">ONE CLINIC · PRIVATE RECEPTION WORK</p>
          <h1 tabIndex={-1}>Website requests</h1>
          <p>
            A request reserves no place until staff confirms the full attendance
            window.
          </p>
        </div>
        <button
          className="staff-button staff-button-primary"
          disabled={busy}
          onClick={async () => {
            const result = await run("refresh");
            if (result) {
              await load();
              setFeedback(
                result.partial
                  ? "Refresh paused at its time limit. Some requests or tracking updates remain pending; use Refresh requests again."
                  : "Requests refreshed. Tracking delivery status reflects persisted acknowledgements.",
              );
            }
          }}
        >
          {busy ? "Refreshing…" : "Refresh requests"}
        </button>
      </div>
      <div className="staff-actions">
        <button
          className="staff-button"
          aria-pressed={view === "requests"}
          onClick={() => setView("requests")}
        >
          Inbox
        </button>
        <button
          className="staff-button"
          aria-pressed={view === "notices"}
          onClick={() => setView("notices")}
        >
          Notification worklist
        </button>
      </div>
      {feedback && (
        <p role="status" className="request-alert">
          {feedback}
        </p>
      )}
      {error && (
        <p role="alert" className="request-error">
          {error}
        </p>
      )}
      {view === "requests" && (
        <form
          className="request-inbox-filters"
          onSubmit={(e) => {
            e.preventDefault();
            setPage(0);
            void load();
          }}
        >
          <label className="request-field">
            Search name or reference
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              maxLength={80}
            />
          </label>
          <label className="request-field">
            Status
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">All statuses</option>
              {Object.entries(names).map(([v, n]) => (
                <option key={v} value={v}>
                  {n}
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
          <button className="staff-button" disabled={busy}>
            Search
          </button>
        </form>
      )}
      {view === "notices" && (
        <label className="request-field">
          Notification status
          <select
            value={noticeState}
            onChange={(e) => setNoticeState(e.target.value)}
          >
            <option value="">Needs follow-up</option>
            <option value="all">All history</option>
            {Object.entries(noticeNames).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
      )}
      {!rows.length ? (
        <div className="request-alert">
          {busy
            ? "Loading…"
            : error
              ? "Requests unavailable. Try Refresh requests."
              : "No requests found."}
        </div>
      ) : view === "requests" ? (
        <>
          <div className="request-inbox-table">
            <table>
              <thead>
                <tr>
                  <th>Reference</th>
                  <th>Patient</th>
                  <th>Session window</th>
                  <th>Status / tracking</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((x) => (
                  <tr key={x.id}>
                    <td>{x.reference}</td>
                    <td>
                      {fullName(x.patient)}
                      {x.phoneReview && <small>Shared-phone review flag</small>}
                    </td>
                    <td>
                      {x.selection.professionalName}
                      <br />
                      <bdi>
                        {x.selection.date} · {x.selection.startTime}–
                        {x.selection.endTime}
                      </bdi>
                    </td>
                    <td>
                      <span className={`request-status status-${x.status}`}>
                        {names[x.status]}
                      </span>
                      <span className="request-status">
                        {!x.trackingExpired && x.syncedSequence === x.sequence
                          ? "Tracking synchronized"
                          : x.trackingExpired
                            ? "Tracking expired"
                            : "Tracking update pending"}
                      </span>
                    </td>
                    <td>
                      <button
                        className="staff-button"
                        disabled={busy}
                        onClick={() => open(x.id)}
                      >
                        Review {x.reference}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="request-inbox-mobile">
            {rows.map((x) => (
              <article key={x.id}>
                <strong>
                  {x.reference} · {names[x.status]}
                </strong>
                <p>
                  {fullName(x.patient)}
                  <br />
                  {x.selection.professionalName}
                  <br />
                  <bdi>
                    {x.selection.date} · {x.selection.startTime}–
                    {x.selection.endTime}
                  </bdi>
                </p>
                <button className="staff-button" onClick={() => open(x.id)}>
                  Review {x.reference}
                </button>
              </article>
            ))}
          </div>
        </>
      ) : (
        <div className="request-inbox-mobile-always">
          {rows.map((n) => (
            <article className="request-card" key={n.id}>
              <strong>{noticeNames[n.state] ?? n.state}</strong>
              <p>Created {new Date(n.createdAt).toLocaleString()}</p>
              <button className="staff-button" onClick={() => openNotice(n.id)}>
                Review notice
              </button>
            </article>
          ))}
        </div>
      )}
      <div className="staff-actions">
        <button
          className="staff-button"
          disabled={busy || page === 0}
          onClick={() => {
            setPage(0);
            void load();
          }}
        >
          First page
        </button>
        <span>Page {page + 1}</span>
        <button
          className="staff-button"
          disabled={busy || next === null}
          onClick={() => {
            setPage((p) => p + 1);
            void load(next);
          }}
        >
          Next page
        </button>
      </div>
      {r && (
        <PreviewDialog title={`Review ${r.reference}`} onClose={close}>
          <fieldset className="request-fields" disabled={busy}>
            <div className="request-alert">
              <strong>{names[r.status]}</strong>
              <p>
                {!r.trackingExpired && r.syncedSequence === r.sequence
                  ? "Tracking synchronized"
                  : r.trackingExpired
                    ? "Tracking link expired. The local booking remains intact; no further public update is promised."
                    : "Tracking update pending — a local booking remains valid during public delivery failure."}
              </p>
            </div>
            <h3>Submitted patient details — private</h3>
            <dl className="request-review-grid">
              {[
                ["First name", r.patient.firstName],
                ["Father’s name", r.patient.fatherName],
                ["Last name", r.patient.lastName],
                ["Mother’s maiden name", r.patient.motherFirstName],
                ["Date of birth", r.patient.dateOfBirth],
                ["Submitted phone", r.patient.phone],
                ["Gender", r.patient.gender],
                ["Language", r.language],
              ].map(([k, v]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd>
                    <bdi>{v}</bdi>
                  </dd>
                </div>
              ))}
            </dl>
            <p>
              {r.selection.professionalName} ·{" "}
              <bdi>
                {r.selection.date} · {r.selection.startTime}–
                {r.selection.endTime}
              </bdi>
            </p>
            {r.status === "awaiting" && !r.linkedPatientId && (
              <section>
                <h3>Patient matching</h3>
                <p>
                  Compare every name and date. Phone is supporting evidence
                  only. No existing record is overwritten.
                </p>
                {detail.matches.candidates.map((c) => (
                  <label className="request-match" key={c.id}>
                    <input
                      type="radio"
                      name="request-patient"
                      value={c.id}
                      checked={selected === c.id}
                      onChange={() => {
                        setSelected(c.id);
                        setAck(false);
                      }}
                    />
                    <span>
                      <strong>
                        {c.classification}: {fullName(c)}
                      </strong>
                      <br />
                      DOB: {c.dateOfBirth} · Submitted DOB:{" "}
                      {r.patient.dateOfBirth}
                      {c.dateOfBirth !== r.patient.dateOfBirth
                        ? " — dates differ"
                        : " — matches"}
                      <br />
                      Mother: {c.motherFirstName}
                    </span>
                  </label>
                ))}
                <label className="request-field">
                  Private reason / discrepancy review
                  <textarea
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    maxLength={500}
                  />
                </label>
                <label className="request-checkbox">
                  <input
                    type="checkbox"
                    checked={ack}
                    onChange={(e) => setAck(e.target.checked)}
                  />
                  I reviewed these candidates and discrepancies.
                </label>
                <div className="staff-actions">
                  <button
                    className="staff-button"
                    disabled={!selected || !ack || !reason.trim()}
                    onClick={() => {
                      const p = detail.matches.candidates.find(
                        (p) => p.id === selected,
                      );
                      void change("link", {
                        patientId: p.id,
                        patientRevision: p.revision,
                        acknowledged: true,
                        reason,
                      });
                    }}
                  >
                    Link reviewed patient
                  </button>
                  <button
                    className="staff-button"
                    disabled={!ack || !reason.trim()}
                    onClick={() =>
                      change("createPatient", {
                        reviewDigest: detail.matches.reviewDigest,
                        duplicateOverride: { acknowledged: true, reason },
                      })
                    }
                  >
                    Create separate patient
                  </button>
                </div>
              </section>
            )}
            {r.linkedPatientId && (
              <p className="request-note">
                Patient reviewed and linked. Registry details were not
                overwritten.
              </p>
            )}
            <label className="request-field">
              Private staff notes
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                maxLength={2000}
              />
            </label>
            <button
              className="staff-button"
              onClick={() => change("notes", { notes })}
            >
              Save private notes
            </button>
            {r.status === "awaiting" && (
              <div className="staff-actions">
                <button
                  className="staff-button staff-button-primary"
                  disabled={!r.linkedPatientId}
                  onClick={async () => {
                    const v = await run("review", { id: r.id });
                    if (v) {
                      setReview({ ...v, key: crypto.randomUUID() });
                      setDecision("confirm");
                    }
                  }}
                >
                  Confirm request
                </button>
                <button
                  className="staff-button"
                  onClick={() => {
                    setDecision("reject");
                    setReason("");
                  }}
                >
                  Reject request
                </button>
                <button
                  className="staff-button"
                  disabled={!r.linkedPatientId}
                  onClick={() => {
                    setDecision("reconcile");
                    setSelected("");
                    setReason("");
                    setAck(false);
                  }}
                >
                  Reconcile existing booking
                </button>
              </div>
            )}
            {r.status === "confirmed" && (
              <>
                <p>
                  Booking reference: <strong>{r.bookingReference}</strong>.
                  Attendance window, not an exact consultation time; order
                  follows check-in.
                </p>
                <button
                  className="staff-button"
                  onClick={() => {
                    setDecision("cancel");
                    setReason("");
                    setNotes("");
                  }}
                >
                  Cancel linked booking
                </button>
              </>
            )}
            {decision === "confirm" && review && (
              <div className="request-note">
                <h3>Review and confirm</h3>
                <p>
                  <bdi>
                    {review.session.startTime}–{review.session.endTime}
                  </bdi>{" "}
                  ·{" "}
                  {review.session.capacity === null
                    ? "Not configured"
                    : `${review.session.remaining} remaining`}
                </p>
                {review.overlaps.length > 0 && (
                  <p className="request-alert">
                    This patient has an overlapping booking. Review it before
                    continuing.
                  </p>
                )}
                <button
                  className="staff-button staff-button-primary"
                  disabled={
                    review.session.capacity === null ||
                    review.session.remaining === 0
                  }
                  onClick={() =>
                    change("confirm", {
                      booking: {
                        patientId: review.patient.id,
                        patientRevision: review.patient.revision,
                        date: r.selection.date,
                        scopeId: r.scopeId,
                        sourceSessionId: r.selection.sourceSessionId,
                        sessionVersion: review.session.version,
                        idempotencyKey: review.key,
                      },
                    })
                  }
                >
                  Confirm booking
                </button>
              </div>
            )}
            {["reject", "cancel"].includes(decision) && (
              <div className="request-note">
                <label className="request-field">
                  Patient-facing reason
                  <select
                    aria-label="Patient-facing reason"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                  >
                    <option value="" disabled>
                      Choose a fixed reason
                    </option>
                    {Object.entries(REQUEST_REASONS).map(([k, v]) => (
                      <option key={k} value={k}>
                        {v.en}
                      </option>
                    ))}
                  </select>
                </label>
                {decision === "cancel" && (
                  <label className="request-field">
                    Private cancellation reason
                    <textarea
                      value={notes}
                      onChange={(e) => setNotes(e.target.value)}
                      maxLength={240}
                    />
                  </label>
                )}
                <button
                  className="staff-button"
                  disabled={!reason || (decision === "cancel" && !notes.trim())}
                  onClick={() =>
                    change(decision, {
                      reason,
                      ...(decision === "cancel"
                        ? { privateReason: notes }
                        : {}),
                    })
                  }
                >
                  Confirm {decision === "cancel" ? "cancellation" : "rejection"}
                </button>
              </div>
            )}
            {decision === "reconcile" && (
              <div className="request-note">
                <label className="request-field">
                  Existing active booking
                  <select
                    aria-label="Existing active booking"
                    value={selected}
                    onChange={(e) => setSelected(e.target.value)}
                  >
                    <option value="" disabled>
                      Choose the reviewed booking
                    </option>
                    {(detail.existingBookings ?? []).map((b) => (
                      <option key={b._id} value={b._id}>
                        {b.bookingNumber} · {b.professionalName} · {b.date} ·{" "}
                        {b.startTime}–{b.endTime}
                      </option>
                    ))}
                  </select>
                  {!detail.existingBookings?.length && (
                    <small>
                      No active matching patient/session booking was found.
                    </small>
                  )}
                </label>
                <label className="request-field">
                  Private reconciliation reason
                  <input
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    maxLength={500}
                  />
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={ack}
                    onChange={(e) => setAck(e.target.checked)}
                  />
                  I checked the active booking belongs to this patient and
                  session.
                </label>
                <button
                  className="staff-button"
                  disabled={!selected || !reason || !ack}
                  onClick={() =>
                    change("reconcileBooking", {
                      bookingId: selected,
                      reason,
                      acknowledged: true,
                    })
                  }
                >
                  Link existing booking
                </button>
              </div>
            )}
            <h3>Notifications</h3>
            {detail.notices.map((n) => (
              <p key={n.id}>
                {noticeNames[n.state]}{" "}
                <button
                  className="staff-button"
                  onClick={() => openNotice(n.id)}
                >
                  {["sent", "superseded", "opened"].includes(n.state)
                    ? "View notice history"
                    : "Send via WhatsApp"}
                </button>
              </p>
            ))}
            <h3>Lost tracking link</h3>
            {r.rotationPending && (
              <p className="request-alert" role="status">
                Link replacement is pending reconciliation with the public
                service. Refresh requests to recover it; do not start another
                replacement.
              </p>
            )}
            <p>
              Replacement goes only to the original unverified submitted phone.
              This does not verify identity or authorize patient history access.
            </p>
            <button
              className="staff-button"
              onClick={() => {
                setDecision("rotate");
                setReason("");
                setAck(false);
                setRotationKey(key());
              }}
            >
              Replace tracking link
            </button>
            {decision === "rotate" && (
              <div className="request-note">
                <label className="request-field">
                  Reason
                  <input
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    maxLength={240}
                  />
                </label>
                <label className="request-checkbox">
                  <input
                    type="checkbox"
                    checked={ack}
                    onChange={(e) => setAck(e.target.checked)}
                  />
                  Replace the old link and send only to the original unverified
                  submitted phone.
                </label>
                <button
                  className="staff-button"
                  disabled={!reason.trim() || !ack}
                  onClick={() =>
                    change("rotate", {
                      key: rotationKey,
                      reason,
                      confirmed: true,
                    })
                  }
                >
                  Confirm link replacement
                </button>
                <p>
                  One replacement per minute; three per day. A retry uses the
                  same request key.
                </p>
              </div>
            )}
            <h3>Private action history</h3>
            <ul>
              {detail.audit.map((x) => (
                <li key={x._id}>
                  {x.action} · {new Date(x.at).toLocaleString()}
                </li>
              ))}
            </ul>
            {error && (
              <p role="alert" className="request-error">
                {error}
              </p>
            )}
          </fieldset>
        </PreviewDialog>
      )}
      {notice && (
        <PreviewDialog
          title="Manual WhatsApp"
          onClose={() => {
            setNotice(null);
            setNoticeId(null);
            setAck(false);
            setReason("");
          }}
        >
          <div className="request-alert">
            Messages are sent from the WhatsApp account signed in on this
            computer. Opening is not delivery. Localhost tracking links work
            only on this review computer.
          </div>
          <label className="request-field">
            Message language
            <select
              aria-label="Message language"
              value={language}
              onChange={async (e) => {
                setLanguage(e.target.value);
                const out = await run("notification", {
                  noticeId,
                  noticeAction: "preview",
                  language: e.target.value,
                });
                if (out) setNotice(out);
              }}
            >
              <option value="en">English</option>
              <option value="ar">العربية</option>
            </select>
          </label>
          {notice.openingUncertain && (
            <div className="request-alert">
              <p>
                An opening attempt may have occurred, but its outcome is not
                recorded. Check WhatsApp before trying again. Nothing is marked
                sent.
              </p>
              <button
                className="staff-button"
                disabled={busy || notice.stale}
                onClick={() => noticeAction("resolve_uncertain")}
              >
                I checked WhatsApp — allow another opening
              </button>
            </div>
          )}
          {notice.phoneWarning && (
            <p className="request-alert" role="status">
              {notice.phoneWarning}
            </p>
          )}
          <pre
            className="request-message"
            dir={language === "ar" ? "rtl" : "ltr"}
          >
            {notice.message.split("\n").map((line, i) => (
              <span key={i}>
                {/^\*[^*]+\*$/.test(line) ? (
                  <strong>{line.slice(1, -1)}</strong>
                ) : (
                  line
                )}
                {"\n"}
              </span>
            ))}
          </pre>
          <p>
            {noticeNames[notice.notice.state]}
            {notice.stale ? " — outdated notice; history only" : ""}
          </p>
          <label className="request-checkbox">
            <input
              type="checkbox"
              checked={ack}
              onChange={(e) => setAck(e.target.checked)}
            />
            I checked the original submitted phone, including any difference
            from the registry. This phone remains unverified.
          </label>
          <label className="request-checkbox">
            <input
              type="checkbox"
              checked={sentAck}
              disabled={notice.stale || notice.notice.state !== "opened"}
              onChange={(e) => setSentAck(e.target.checked)}
            />
            I manually sent this message in WhatsApp.
          </label>
          <div className="staff-actions">
            <button
              className="staff-button staff-button-primary"
              disabled={
                busy ||
                notice.stale ||
                notice.openingUncertain ||
                !ack ||
                notice.notice.state === "sent"
              }
              onClick={openWhatsApp}
            >
              Send via WhatsApp
            </button>
            <button
              className="staff-button"
              disabled={
                busy ||
                notice.stale ||
                notice.notice.state !== "opened" ||
                !sentAck
              }
              onClick={() => noticeAction("sent")}
            >
              I manually sent it — mark sent
            </button>
            <button
              className="staff-button"
              disabled={busy || notice.stale}
              onClick={() => noticeAction("call_required")}
            >
              Call fallback
            </button>
          </div>
          <label className="request-field">
            Private call outcome
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={240}
            />
          </label>
          <button
            className="staff-button"
            disabled={busy || notice.stale || !reason.trim()}
            onClick={() => noticeAction("call_recorded", { outcome: reason })}
          >
            Record call outcome
          </button>
          <h3>Notification history</h3>
          <ul>
            {notice.notice.history.map((h, i) => (
              <li key={i}>
                {h.action} · {new Date(h.at).toLocaleString()}
              </li>
            ))}
          </ul>
          {error && (
            <p role="alert" className="request-error">
              {error}
            </p>
          )}
        </PreviewDialog>
      )}
    </div>
  );
}
