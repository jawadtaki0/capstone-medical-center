import { useEffect, useId, useState } from "react";
import LoadingStatus from "../../../../shared/ui/LoadingStatus.jsx";
import { useTask } from "./useTask.js";
import { TEXT } from "./assistantText.js";

// Published sessions the person may book. A full one offers later dates for the
// same professional, then other professionals in the specialty.
export default function AssistantSessions({
  api,
  language,
  today,
  initialDate,
  initialProfessional = "",
  autoLoad,
  excludeId,
  selected,
  onSelect,
  onError,
}) {
  const t = TEXT[language],
    id = useId();
  const { busy, error, run } = useTask(onError);
  const [date, setDate] = useState(initialDate),
    [sessions, setSessions] = useState(null),
    [professional, setProfessional] = useState(initialProfessional),
    [alternatives, setAlternatives] = useState(null);

  async function load() {
    onSelect(null);
    setAlternatives(null);
    const result = await run(() => api.bookingSessions({ date }));
    if (result)
      setSessions(
        result.sessions.filter((s) => s.canBook && s.id !== excludeId),
      );
  }
  useEffect(() => {
    if (autoLoad) load();
  }, []);
  async function other(session, specialty) {
    const result = await run(() =>
      api.assistantAlternatives({
        professionalId: session.professionalId,
        date,
        ...(specialty ? { specialty: session.specialty } : {}),
      }),
    );
    if (result)
      setAlternatives({
        ...result,
        sessions: result.sessions.filter((s) => s.id !== excludeId),
        session,
        specialty,
      });
  }

  const professionals = new Set((sessions ?? []).map((s) => s.professionalId));
  // A pre-filled doctor who is not on this date must not hide everyone else.
  const filter = professionals.has(professional) ? professional : "";
  const shown = (sessions ?? []).filter(
    (s) => !filter || s.professionalId === filter,
  );
  const places = (s) =>
    s.capacity === null
      ? t.unset
      : s.remaining
        ? t.remaining(s.remaining, s.capacity)
        : t.full;
  const row = (s) => (
    <label className="booking-session" key={s.id}>
      <input
        type="radio"
        name={`${id}-session`}
        checked={selected?.id === s.id}
        disabled={busy || !s.remaining}
        onChange={() => onSelect(s)}
      />
      <span>
        <strong>
          <bdi>{s.professionalName}</bdi> · <bdi>{s.date}</bdi> ·{" "}
          <bdi>
            {s.startTime}–{s.endTime}
          </bdi>
        </strong>
        <br />
        <bdi>{s.clinicName}</bdi> · {places(s)}
      </span>
    </label>
  );

  return (
    <>
      <h2>{t.session}</h2>
      <div className="staff-form-grid booking-fields">
        <label className="staff-field">
          {t.date}
          <input
            type="date"
            min={today}
            value={date}
            disabled={busy}
            onChange={(e) => {
              onSelect(null);
              setDate(e.target.value);
              setSessions(null);
              setAlternatives(null);
            }}
          />
        </label>
        <button
          type="button"
          className="staff-button"
          disabled={busy || !date}
          onClick={load}
        >
          {t.load}
        </button>
      </div>
      {busy && <LoadingStatus label="Checking…" />}
      {error && (
        <p className="staff-error" role="alert">
          {error}
        </p>
      )}
      {sessions && !shown.length && <p role="status">{t.noSessions}</p>}
      <div className="booking-list">{shown.map(row)}</div>
      {filter && professionals.size > 1 && (
        <button
          type="button"
          className="staff-button"
          onClick={() => setProfessional("")}
        >
          {t.allProfessionals}
        </button>
      )}
      <div className="staff-actions">
        {shown
          .filter((s) => s.capacity !== null && !s.remaining)
          .map((s) => (
            <button
              key={s.id}
              type="button"
              className="staff-button"
              disabled={busy}
              onClick={() => other(s, false)}
            >
              {t.otherDates(s.professionalName)}
            </button>
          ))}
      </div>
      {alternatives &&
        (alternatives.sessions.length ? (
          <div className="booking-list">{alternatives.sessions.map(row)}</div>
        ) : (
          <>
            <p role="status">{t.noAlternatives(alternatives.days)}</p>
            {!alternatives.specialty && (
              <button
                type="button"
                className="staff-button"
                disabled={busy}
                onClick={() => other(alternatives.session, true)}
              >
                {t.otherDoctors(alternatives.session.specialty)}
              </button>
            )}
          </>
        ))}
    </>
  );
}
