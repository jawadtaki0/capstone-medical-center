import { useState } from "react";
import Icon from "./Icon.jsx";
import LoadingStatus from "./PublicLoadingStatus.jsx";
import { longDate, timeRange } from "../lib/scheduleDate.js";
import { specialtyLabel } from "../data/specialties.js";
import { professionalName } from "../data/professionalNames.js";

export function HomeSession({ session, onPreview }) {
  const name = professionalName(session.doctorName ?? session.name);
  return (
    <article className="home-session">
      <div>
        <h3>{name}</h3>
        <p>{specialtyLabel(session.specialty)}</p>
        <p className="home-session-time">
          {timeRange(session.startTime, session.endTime)}
        </p>
        {session.appointmentRequired && (
          <p className="home-appointment-note">Appointment required</p>
        )}
      </div>
      {session.status === "active" ? (
        <button
          className="home-session-action"
          type="button"
          onClick={() => onPreview("Book an appointment", session)}
          aria-label={`Request a session with ${name}`}
        >
          Request session
        </button>
      ) : (
        <span className="home-session-status">
          {session.status === "cancelled" ? "Cancelled" : "Unavailable"}
        </span>
      )}
    </article>
  );
}

export default function HomeSchedule({ result, onRetry, onPreview }) {
  const [expanded, setExpanded] = useState(false);
  const schedule = result.status === "success" ? result.schedule : null;
  const published = schedule?.publicationStatus === "published";
  const sessions =
    published && !schedule.centerClosed
      ? [...schedule.doctorSessions, ...schedule.specialistSessions]
      : [];
  const visible = expanded ? sessions : sessions.slice(0, 3);
  return (
    <div className="home-schedule" aria-labelledby="home-schedule-title">
      <div className="home-schedule-masthead">
        <div className="home-schedule-heading">
          <Icon name="calendar" />
          <h2 id="home-schedule-title">Today at Cedar</h2>
        </div>
        <p className="home-schedule-date">
          {schedule ? longDate(schedule.date) : "Today’s published schedule"}
        </p>
      </div>
      {published && (
        <p className="home-center-hours">
          <Icon name="clock" />
          {schedule.centerClosed
            ? "The center is closed today"
            : schedule.centerHours
              ? `Center hours ${timeRange(schedule.centerHours.startTime, schedule.centerHours.endTime)}`
              : "Center opening hours are not listed"}
        </p>
      )}
      <div
        className="home-schedule-content"
        id="home-schedule-content"
        data-expanded={expanded}
      >
        {result.status === "loading" && (
          <div className="home-schedule-state">
            <LoadingStatus label="Loading today’s schedule…" wakeHint />
            <p>Checking published sessions and opening hours.</p>
          </div>
        )}
        {result.status === "error" && (
          <div className="home-schedule-state" role="alert">
            <h3>Today’s schedule couldn’t be loaded.</h3>
            <p>Please try again, or browse the full schedule.</p>
            <button className="home-link" type="button" onClick={onRetry}>
              Try again
            </button>
          </div>
        )}
        {schedule && !published && (
          <div className="home-schedule-state">
            <h3>Today’s schedule is not available yet.</h3>
            <p>Please check again later or choose another day.</p>
          </div>
        )}
        {published && (schedule.centerClosed || !sessions.length) && (
          <div className="home-schedule-state">
            <h3>
              {schedule.centerClosed
                ? "The center is closed today."
                : "No clinic sessions today."}
            </h3>
            <p>Browse another day for clinic sessions and service hours.</p>
          </div>
        )}
        {visible.map((session) => (
          <HomeSession
            key={`${session.professionalId}:${session.id}`}
            session={session}
            onPreview={onPreview}
          />
        ))}
        {sessions.length > 3 && (
          <button
            className="home-expand"
            type="button"
            aria-expanded={expanded}
            aria-controls="home-schedule-content"
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded
              ? "Show fewer sessions"
              : `Show all ${sessions.length} sessions`}
            <Icon name="chevron" />
          </button>
        )}
        {published &&
          !schedule.centerClosed &&
          schedule.otherServices.length > 0 && (
            <div className="home-other-hours">
              <h3>Other service hours</h3>
              {schedule.otherServices.map((service) => (
                <p key={service.id}>
                  <span>{service.name}</span>
                  <span>{timeRange(service.startTime, service.endTime)}</span>
                </p>
              ))}
            </div>
          )}
      </div>
      <a className="home-schedule-browse" href="/schedule">
        <span>
          Find another day<small>Browse the full schedule</small>
        </span>
        <Icon name="calendar" />
      </a>
    </div>
  );
}
