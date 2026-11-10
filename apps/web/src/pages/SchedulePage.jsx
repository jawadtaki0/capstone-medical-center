import { useEffect, useState } from "react";
import LoadingStatus from "../components/PublicLoadingStatus.jsx";
import PublicSessionRow from "../components/PublicSessionRow.jsx";
import PublicPage from "../components/PublicPage.jsx";
import useSchedule from "../hooks/useSchedule.js";
import {
  beirutToday,
  dateObject,
  addDays,
  mondayOf,
  formatDate,
  longDate,
  timeRange,
} from "../lib/scheduleDate.js";
import "./schedule.css";

export default function SchedulePage({ onPreview }) {
  const [selectedDate, setSelectedDate] = useState(beirutToday);
  const { result, retry } = useSchedule(selectedDate);

  useEffect(() => {
    const previousTitle = document.title;
    document.title = "Schedule · Cedar Medical Center";
    return () => {
      document.title = previousTitle;
    };
  }, []);

  const firstDay = mondayOf(selectedDate);
  const days = Array.from({ length: 7 }, (_, index) =>
    addDays(firstDay, index),
  );
  const schedule = result.status === "success" ? result.schedule : null;
  const doctorSessions = schedule?.doctorSessions ?? [];
  const specialistSessions = schedule?.specialistSessions ?? [];
  const otherServices = schedule?.otherServices ?? [];
  const published = schedule?.publicationStatus === "published";

  return (
    <PublicPage className="schedule-page public-schedule">
      <div className="container schedule-shell">
        <div className="schedule-intro">
          <h1>Find a day that works for you.</h1>
          <p>
            Choose a day to see its doctor sessions and other scheduled
            services.
          </p>
        </div>

        <section className="schedule-picker" aria-labelledby="choose-day-title">
          <div className="schedule-picker-heading">
            <div>
              <h2 id="choose-day-title">Choose a day</h2>
              <p>Week of {longDate(firstDay)}</p>
            </div>
            <div className="schedule-week-actions">
              <button
                className="schedule-week-button"
                type="button"
                onClick={() => setSelectedDate((date) => addDays(date, -7))}
                aria-label="Previous week"
              >
                ← Previous
              </button>
              <button
                className="schedule-week-button"
                type="button"
                onClick={() => setSelectedDate(beirutToday())}
              >
                Today
              </button>
              <button
                className="schedule-week-button"
                type="button"
                onClick={() => setSelectedDate((date) => addDays(date, 7))}
                aria-label="Next week"
              >
                Next →
              </button>
            </div>
          </div>
          <div className="schedule-day-scroll">
            <div
              className="schedule-days"
              role="group"
              aria-label="Select a schedule day"
            >
              {days.map((date) => (
                <button
                  key={date}
                  type="button"
                  className="schedule-day"
                  aria-label={longDate(date)}
                  aria-pressed={selectedDate === date}
                  onClick={() => setSelectedDate(date)}
                >
                  <span className="schedule-day-name">
                    {formatDate(date, { weekday: "short" })}
                  </span>
                  <strong>{dateObject(date).getUTCDate()}</strong>
                  <span className="schedule-day-month">
                    {formatDate(date, { month: "short" })}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </section>

        <section
          className="schedule-results"
          aria-labelledby="schedule-results-title"
        >
          <div className="schedule-results-heading">
            <h2 id="schedule-results-title">{longDate(selectedDate)}</h2>
          </div>

          {result.status === "loading" && (
            <div className="schedule-state">
              <LoadingStatus label="Loading this day’s schedule…" wakeHint />
            </div>
          )}
          {result.status === "error" && (
            <div className="schedule-state schedule-error" role="alert">
              <p>We couldn’t load this day’s schedule. Please try again.</p>
              <button
                className="button schedule-outline-button"
                type="button"
                onClick={retry}
              >
                Try again
              </button>
            </div>
          )}

          {schedule && !published && (
            <div className="schedule-state" role="status">
              <h3>The schedule is not available for this date yet.</h3>
              <p>Please check again later or choose another day.</p>
            </div>
          )}
          {published && schedule.centerClosed && (
            <div className="schedule-state" role="status">
              <h3>The center is closed on this day.</h3>
              <p>Choose another day to view sessions and service hours.</p>
            </div>
          )}

          {published && !schedule.centerClosed && (
            <>
              <p className="schedule-center-hours">
                Opening hours:{" "}
                {timeRange(
                  schedule.centerHours.startTime,
                  schedule.centerHours.endTime,
                )}
              </p>
              <p className="schedule-announcement" role="status">
                {doctorSessions.length} doctor{" "}
                {doctorSessions.length === 1 ? "session" : "sessions"} for{" "}
                {longDate(selectedDate)}.
              </p>
              {doctorSessions.length > 0 ? (
                <div className="schedule-card-list">
                  {doctorSessions.map((session) => (
                    <PublicSessionRow
                      session={session}
                      label="Doctor session"
                      onPreview={onPreview}
                      key={`${selectedDate}-${session.id}`}
                    />
                  ))}
                </div>
              ) : (
                <div className="schedule-state">
                  No doctor sessions are scheduled for this day.
                </div>
              )}

              {specialistSessions.length > 0 && (
                <section
                  className="schedule-other"
                  aria-labelledby="specialists-title"
                >
                  <h3 id="specialists-title">Specialist sessions</h3>
                  <div className="schedule-card-list">
                    {specialistSessions.map((session) => (
                      <PublicSessionRow
                        session={session}
                        label="Specialist session"
                        onPreview={onPreview}
                        key={`${selectedDate}-${session.id}`}
                      />
                    ))}
                  </div>
                </section>
              )}

              {otherServices.length > 0 && (
                <section
                  className="schedule-other"
                  aria-labelledby="other-services-title"
                >
                  <h3 id="other-services-title">Other services today</h3>
                  <div className="schedule-other-row">
                    {otherServices.map((service) => (
                      <div className="schedule-other-item" key={service.id}>
                        <strong>{service.name}</strong>
                        <span>
                          {timeRange(service.startTime, service.endTime)}
                        </span>
                      </div>
                    ))}
                  </div>
                </section>
              )}
            </>
          )}
        </section>
      </div>
    </PublicPage>
  );
}
