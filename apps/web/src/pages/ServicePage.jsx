import { useState } from "react";
import PublicPage from "../components/PublicPage.jsx";
import Icon from "../components/Icon.jsx";
import LoadingStatus from "../../../../shared/ui/LoadingStatus.jsx";
import useSchedule from "../hooks/useSchedule.js";
import { services } from "../data/homeContent.js";
import {
  beirutToday,
  addDays,
  longDate,
  timeRange,
} from "../lib/scheduleDate.js";
import "./schedule.css";
import "./service.css";

// Uses the same accepted public schedule as Home/Schedule. It does not read
// operational records, calculate availability or create a second hours source.
export function ServiceInformation({ service, result, onRetry }) {
  const schedule = result.status === "success" ? result.schedule : null;
  const published = schedule?.publicationStatus === "published";
  const clinic = service.slug === "clinic";
  const sessions = !schedule
    ? []
    : clinic
      ? [...schedule.doctorSessions, ...schedule.specialistSessions].sort(
          (a, b) => a.startTime.localeCompare(b.startTime),
        )
      : schedule.otherServices.filter(
          (item) =>
            item.name.trim().toLowerCase() === service.title.toLowerCase(),
        );
  return (
    <section className="schedule-results" aria-labelledby="service-hours-title">
      <h2 id="service-hours-title">
        Published {clinic ? "clinic sessions" : "service hours"}
      </h2>
      {result.status === "loading" && (
        <div className="schedule-state">
          <LoadingStatus label="Loading published service hours…" wakeHint />
        </div>
      )}
      {result.status === "error" && (
        <div className="schedule-state schedule-error" role="alert">
          <p>We couldn’t load these published hours. Please try again.</p>
          <button
            type="button"
            className="button schedule-outline-button"
            onClick={onRetry}
          >
            Try again
          </button>
        </div>
      )}
      {schedule && !published && (
        <p className="schedule-state" role="status">
          The schedule is not available for this date yet.
        </p>
      )}
      {published && schedule.centerClosed && (
        <p className="schedule-state" role="status">
          The center is closed on this day.
        </p>
      )}
      {published && !schedule.centerClosed && (
        <>
          <p className="schedule-center-hours">
            Center opening hours:{" "}
            {timeRange(
              schedule.centerHours.startTime,
              schedule.centerHours.endTime,
            )}
          </p>
          {sessions.length === 0 ? (
            <p className="schedule-state" role="status">
              No published {service.title} hours{clinic ? " or sessions" : ""}{" "}
              for this date.
            </p>
          ) : (
            <div className="schedule-card-list">
              {sessions.map((session, index) => (
                <article
                  className="schedule-card"
                  key={`${session.id}-${index}`}
                >
                  <div className="schedule-card-details">
                    <h3>
                      {clinic
                        ? (session.doctorName ?? session.name)
                        : service.title}
                    </h3>
                    {clinic && session.specialty && (
                      <p className="schedule-specialty">{session.specialty}</p>
                    )}
                    {session.appointmentRequired && (
                      <p className="schedule-appointment-note">
                        Appointment required
                      </p>
                    )}
                    <p className="schedule-card-meta">
                      <Icon name="clock" />{" "}
                      {timeRange(session.startTime, session.endTime)}
                    </p>
                    {session.status === "cancelled" && (
                      <p className="schedule-cancelled">Cancelled</p>
                    )}
                  </div>
                </article>
              ))}
            </div>
          )}
        </>
      )}
      <div className="service-information-actions">
        {clinic ? (
          <>
            <a className="button button-primary" href="/request">
              Request a clinic session
            </a>
            <a className="button schedule-outline-button" href="/doctors">
              View doctors &amp; specialists
            </a>
          </>
        ) : (
          <p>
            Online booking is not available for {service.title}. Please contact
            reception for service details.
          </p>
        )}
        <a className="text-button" href="/schedule">
          View the full published schedule <Icon name="arrow" />
        </a>
      </div>
    </section>
  );
}

export default function ServicePage({ slug }) {
  const service = services.find((item) => item.slug === slug);
  const [date, setDate] = useState(beirutToday);
  const { result, retry } = useSchedule(date);
  if (!service) return null; // App only routes the explicit public categories.
  return (
    <PublicPage className="schedule-page">
      <div className="container schedule-shell service-information">
        <div className="schedule-intro">
          <p className="eyebrow">CENTER SERVICES</p>
          <h1>{service.title}</h1>
          <p>{service.description}</p>
        </div>
        <section
          className="schedule-picker"
          aria-labelledby="service-date-title"
        >
          <div className="schedule-picker-heading">
            <div>
              <h2 id="service-date-title">Choose a date</h2>
              <p>{longDate(date)} · Asia/Beirut</p>
            </div>
            <div className="schedule-week-actions">
              <button
                type="button"
                className="schedule-week-button"
                onClick={() => setDate((value) => addDays(value, -1))}
              >
                ← Previous day
              </button>
              <button
                type="button"
                className="schedule-week-button"
                onClick={() => setDate(beirutToday())}
              >
                Today
              </button>
              <button
                type="button"
                className="schedule-week-button"
                onClick={() => setDate((value) => addDays(value, 1))}
              >
                Next day →
              </button>
            </div>
          </div>
        </section>
        <ServiceInformation service={service} result={result} onRetry={retry} />
      </div>
    </PublicPage>
  );
}
