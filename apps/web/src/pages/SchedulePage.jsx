import { useEffect, useState } from "react";
import Icon from "../components/Icon.jsx";
import "./schedule.css";

function beirutToday() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Beirut", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function dateObject(date) {
  return new Date(`${date}T12:00:00Z`);
}

function addDays(date, count) {
  const result = dateObject(date);
  result.setUTCDate(result.getUTCDate() + count);
  return result.toISOString().slice(0, 10);
}

function mondayOf(date) {
  const weekday = dateObject(date).getUTCDay();
  return addDays(date, -(weekday === 0 ? 6 : weekday - 1));
}

function formatDate(date, options) {
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", ...options }).format(dateObject(date));
}

function longDate(date) {
  return formatDate(date, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
}

export default function SchedulePage({ onPreview }) {
  const [selectedDate, setSelectedDate] = useState(beirutToday);
  const [retryCount, setRetryCount] = useState(0);
  const [result, setResult] = useState({ date: selectedDate, status: "loading", data: null });

  useEffect(() => {
    const previousTitle = document.title;
    document.title = "Schedule · Cedar Medical Center";
    return () => { document.title = previousTitle; };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setResult({ date: selectedDate, status: "loading", data: null });

    fetch(`/api/schedule?date=${encodeURIComponent(selectedDate)}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Schedule request failed (${response.status})`);
        return response.json();
      })
      .then((data) => setResult({ date: selectedDate, status: "success", data }))
      .catch((error) => {
        if (error.name !== "AbortError") {
          setResult({ date: selectedDate, status: "error", data: null });
        }
      });

    return () => controller.abort();
  }, [selectedDate, retryCount]);

  const firstDay = mondayOf(selectedDate);
  const days = Array.from({ length: 7 }, (_, index) => addDays(firstDay, index));
  const currentResult = result.date === selectedDate ? result : { status: "loading" };
  const schedule = currentResult.status === "success" ? currentResult.data : null;
  const doctorSessions = schedule?.doctorSessions ?? [];
  const otherServices = schedule?.otherServices ?? [];

  return <div className="schedule-page">
    <div className="container schedule-shell">
      <div className="schedule-intro">
        <p className="eyebrow">PUBLIC SCHEDULE · SYNTHETIC SAMPLE DATA</p>
        <h1>Find a day that works for you.</h1>
        <p>Choose a day to see its doctor sessions and other scheduled services.</p>
      </div>

      <section className="schedule-picker" aria-labelledby="choose-day-title">
        <div className="schedule-picker-heading">
          <div>
            <h2 id="choose-day-title">Choose a day</h2>
            <p>Week of {longDate(firstDay)}</p>
          </div>
          <div className="schedule-week-actions">
            <button className="schedule-week-button" type="button" onClick={() => setSelectedDate((date) => addDays(date, -7))} aria-label="Previous week">← Previous</button>
            <button className="schedule-week-button" type="button" onClick={() => setSelectedDate(beirutToday())}>Today</button>
            <button className="schedule-week-button" type="button" onClick={() => setSelectedDate((date) => addDays(date, 7))} aria-label="Next week">Next →</button>
          </div>
        </div>
        <div className="schedule-day-scroll">
          <div className="schedule-days" role="group" aria-label="Select a schedule day">
            {days.map((date) => <button
              key={date}
              type="button"
              className="schedule-day"
              aria-label={longDate(date)}
              aria-pressed={selectedDate === date}
              onClick={() => setSelectedDate(date)}
            >
              <span className="schedule-day-name">{formatDate(date, { weekday: "short" })}</span>
              <strong>{dateObject(date).getUTCDate()}</strong>
              <span className="schedule-day-month">{formatDate(date, { month: "short" })}</span>
            </button>)}
          </div>
        </div>
      </section>

      <section className="schedule-results" aria-labelledby="schedule-results-title">
        <div className="schedule-results-heading">
          <h2 id="schedule-results-title">{longDate(selectedDate)}</h2>
        </div>

        {currentResult.status === "loading" && <div className="schedule-state" role="status">Loading this day’s schedule…</div>}
        {currentResult.status === "error" && <div className="schedule-state schedule-error" role="alert">
          <p>We couldn’t load this day’s schedule. Check that the API is running and try again.</p>
          <button className="button schedule-outline-button" type="button" onClick={() => setRetryCount((count) => count + 1)}>Try again</button>
        </div>}

        {schedule && <>
          <p className="schedule-announcement" role="status">
            {doctorSessions.length} doctor {doctorSessions.length === 1 ? "session" : "sessions"} shown for {longDate(selectedDate)}.
          </p>
          {doctorSessions.length > 0 ? <div className="schedule-card-list">
            {doctorSessions.map((session) => <article className="schedule-card" key={`${selectedDate}-${session.id}`}>
              <div className="schedule-card-details">
                <p className="schedule-card-kicker">DOCTOR SESSION · SAMPLE DATA</p>
                <h3>{session.doctorName}</h3>
                <p className="schedule-specialty">{session.specialty}</p>
                <div className="schedule-card-meta">
                  <span><Icon name="calendar" /> {longDate(session.date)}</span>
                  <span><Icon name="clock" /> {session.startTime}–{session.endTime}</span>
                </div>
              </div>
              {session.status === "cancelled" ? <span className="schedule-cancelled">Cancelled</span> :
                <button className="button schedule-outline-button schedule-book-button" type="button" onClick={() => onPreview("Book appointment")}>Book appointment</button>}
            </article>)}
          </div> : <div className="schedule-state">No doctor sessions are scheduled for this day.</div>}

          {otherServices.length > 0 && <section className="schedule-other" aria-labelledby="other-services-title">
            <h3 id="other-services-title">Other services today</h3>
            <div className="schedule-other-row">
              {otherServices.map((service) => <div className="schedule-other-item" key={service.id}>
                <strong>{service.name}</strong><span>{service.startTime}–{service.endTime}</span>
              </div>)}
            </div>
          </section>}
          {doctorSessions.length === 0 && otherServices.length === 0 &&
            <p className="schedule-empty-note">There are no other services scheduled for this day either.</p>}
        </>}
      </section>
    </div>
  </div>;
}
