// Calendar draft text is independent of the committed grid year. Partial typing
// must not redraw dates; blur/Enter commits only a complete permitted year.
export function calendarYear(draft, maximum = 9999) {
  if (!/^\d{4}$/.test(draft)) return null;
  const value = Number(draft);
  return value >= 1900 && value <= maximum ? value : null;
}

// Only catalogue IDs confer a selection. Labels/URL text never create a session.
export function selectionKey(session) {
  return session
    ? JSON.stringify([
        session.professionalId,
        session.date,
        session.sourceSessionId ?? session.id,
      ])
    : "";
}

export function validatedPreselection(search, sessions) {
  const params = new URLSearchParams(search);
  if (
    [...params.keys()].some(
      (k) => !["professional", "date", "session"].includes(k),
    )
  )
    return null;
  for (const key of ["professional", "date", "session"])
    if (params.getAll(key).length !== 1) return null;
  return (
    sessions.find(
      (s) =>
        s.professionalId === params.get("professional") &&
        s.date === params.get("date") &&
        (s.sourceSessionId ?? s.id) === params.get("session"),
    ) ?? null
  );
}

export function preselectionDate(search) {
  const params = new URLSearchParams(search);
  const date = params.get("date");
  if (
    [...params.keys()].some(
      (k) => !["professional", "date", "session"].includes(k),
    ) ||
    ["professional", "date", "session"].some(
      (k) => params.getAll(k).length !== 1,
    )
  )
    return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? "")) return null;
  const parsed = new Date(`${date}T12:00:00Z`);
  return Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === date
    ? date
    : null;
}

// One atomic catalogue result, protected against delayed superseded responses.
// Failure keeps prior data in the caller; it never becomes a successful empty list.
export function createCatalogueLoader(api, publish) {
  let generation = 0;
  return {
    async load(date, signal) {
      const version = ++generation;
      publish({ status: "loading", date });
      try {
        const [sessions, professionals] = await Promise.all([
          api(`sessions?date=${encodeURIComponent(date)}`, null, signal),
          api(`professionals?date=${encodeURIComponent(date)}`, null, signal),
        ]);
        if (signal?.aborted || version !== generation) return;
        publish({ status: "ready", date, sessions, professionals });
      } catch (error) {
        if (signal?.aborted || version !== generation) return;
        publish({ status: "unavailable", date, error });
      }
    },
    cancel() {
      generation++;
    },
  };
}
