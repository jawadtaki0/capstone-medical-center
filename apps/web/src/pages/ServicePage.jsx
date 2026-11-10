import { useState } from "react";
import PublicPage from "../components/PublicPage.jsx";
import Icon from "../components/Icon.jsx";
import PublicSessionRow from "../components/PublicSessionRow.jsx";
import SmoothDisclosure from "../components/SmoothDisclosure.jsx";
import LabAudioInformation, {
  LabAudioIntro,
} from "../components/LabAudioInformation.jsx";
import LoadingStatus from "../components/PublicLoadingStatus.jsx";
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
              {sessions.map((session, index) =>
                clinic ? (
                  <PublicSessionRow
                    session={session}
                    label={
                      session.kind === "specialist"
                        ? "Specialist session"
                        : "Clinic session"
                    }
                    key={`${session.id}-${index}`}
                  />
                ) : (
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
                        <p className="schedule-specialty">
                          {session.specialty}
                        </p>
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
                ),
              )}
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
    <PublicPage
      className={
        slug === "clinic" ? "clinic-page" : "schedule-page lab-audio-page"
      }
    >
      <div className="container schedule-shell service-information">
        {slug === "clinic" ? (
          <div className="clinic-intro">
            <div>
              <span className="clinic-service-icon">
                <Icon name={service.icon} />
              </span>
              <h1>Clinic consultations</h1>
              <p>
                {service.description} Choose a published attendance window and
                send your request for reception to review.
              </p>
              <a className="button button-primary" href="/doctors">
                Find a doctor
              </a>
              <a className="text-button" href="/schedule">
                View schedule
              </a>
            </div>
            <div
              className="clinic-illustration"
              role="img"
              aria-label="Illustration of planning a clinic visit"
            >
              <div className="clinic-illustration-calendar">
                <Icon name="calendar" />
                <span />
                <span />
                <span />
              </div>
              <div className="clinic-illustration-window">
                <Icon name="clock" />
                <span>
                  Choose a session.
                  <br />
                  Plan your visit.
                </span>
              </div>
              <p>Session-planning illustration</p>
            </div>
          </div>
        ) : (
          <LabAudioIntro laboratory={slug === "laboratory"} />
        )}
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
        {slug !== "clinic" && (
          <LabAudioInformation laboratory={slug === "laboratory"} />
        )}
        {slug === "clinic" && (
          <section
            className="clinic-request-guide"
            aria-labelledby="clinic-request-title"
          >
            <div>
              <h2 id="clinic-request-title">From session to confirmation.</h2>
              <p>
                Choose your session, send your request, then follow reception’s
                decision through your saved private tracking link.
              </p>
            </div>
            <div className="clinic-faq">
              <h3>Before you request</h3>
              {[
                [
                  "Does sending a request reserve a place?",
                  "No. Your request needs reception confirmation before an appointment is reserved.",
                ],
                [
                  "Is the attendance window an exact consultation time?",
                  "No. It is your attendance window; consultation order follows check-in.",
                ],
                [
                  "How do I follow my request?",
                  "Save your complete private tracking link after sending your request. Use it to view synchronized status updates.",
                ],
              ].map(([question, answer]) => (
                <SmoothDisclosure key={question} title={question}>
                  <p>{answer}</p>
                </SmoothDisclosure>
              ))}
            </div>
          </section>
        )}
      </div>
    </PublicPage>
  );
}
