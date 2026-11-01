import { todayCards } from "../lib/operationalSummary.js";
import "./today.css";
import LoadingStatus from "../../../../shared/ui/LoadingStatus.jsx";

export default function Today({
  summary,
  error,
  onNavigate,
  onActivity,
  onRefresh,
  busy,
}) {
  return (
    <section className="staff-today">
      <p className="staff-eyebrow">CENTER-LOCAL · ASIA/BEIRUT</p>
      <h1 tabIndex={-1}>Today</h1>
      <p className="staff-intro">
        Your authorized work and actions needing attention.
      </p>
      {error && (
        <p className="staff-error" role="alert">
          {error}{" "}
          <button type="button" className="staff-button" onClick={onRefresh}>
            Try again
          </button>
        </p>
      )}
      {!summary && !error && <LoadingStatus label="Loading today’s work…" />}
      {summary && (
        <>
          <div className="staff-today-grid">
            {todayCards(summary).map((card) => (
              <button
                key={card.id}
                type="button"
                disabled={busy}
                className={`staff-today-card ${card.count > 0 && card.id !== "bookings" ? (card.problem ? "has-failure" : "needs-action") : ""}`}
                onClick={() => onNavigate(card.target)}
              >
                <span>{card.label}</span>
                {card.count !== undefined && (
                  <strong
                    className={
                      card.count > 0 && card.id !== "bookings"
                        ? "staff-action-count"
                        : "staff-neutral-count"
                    }
                  >
                    {card.count}
                  </strong>
                )}
              </button>
            ))}
          </div>
          <h2>Latest activity</h2>
          {summary.activity.length ? (
            <ul className="staff-today-activity">
              {summary.activity.map((item) => (
                <li
                  key={item.id}
                  className={
                    item.needsAction
                      ? item.actionState === "failure"
                        ? "has-failure"
                        : "needs-action"
                      : ""
                  }
                >
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onActivity(item)}
                  >
                    <strong>{item.label}</strong>
                    <span>
                      {item.viewed ? "Viewed" : "New"} ·{" "}
                      {item.needsAction ? "Needs action" : "Resolved"}
                    </span>
                    <time dateTime={item.at}>
                      {new Intl.DateTimeFormat("en-GB", {
                        timeZone: "Asia/Beirut",
                        dateStyle: "medium",
                        timeStyle: "short",
                      }).format(new Date(item.at))}
                    </time>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p>No recent activity in your assigned scope.</p>
          )}
        </>
      )}
    </section>
  );
}
