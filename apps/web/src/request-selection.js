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
      (k) => !["professional", "date", "session", "start", "end"].includes(k),
    )
  )
    return null;
  for (const key of ["professional", "date", "session"])
    if (params.getAll(key).length !== 1) return null;
  if (params.has("start") || params.has("end")) {
    if (
      ["start", "end"].some(
        (key) =>
          params.getAll(key).length !== 1 ||
          !/^([01]\d|2[0-3]):[0-5]\d$/.test(params.get(key)),
      )
    )
      return null;
  }
  return (
    sessions.find(
      (s) =>
        s.professionalId === params.get("professional") &&
        s.date === params.get("date") &&
        (s.sourceSessionId ?? s.id) === params.get("session") &&
        (!params.has("start") ||
          (s.startTime === params.get("start") &&
            s.endTime === params.get("end"))),
    ) ?? null
  );
}

export function validatedProfessionalPreselection(search, professionals) {
  const params = new URLSearchParams(search);
  if (
    [...params.keys()].some((key) => key !== "professional") ||
    params.getAll("professional").length !== 1
  )
    return null;
  return professionals.find((p) => p.id === params.get("professional")) ?? null;
}

// URL values are hints only; the request form revalidates the full tuple.
export function requestSelectionUrl(session) {
  const professional =
    session?.professionalId ??
    session?.doctorId ??
    session?.specialistId ??
    (["doctor", "specialist"].includes(session?.kind) ? session.id : null);
  if (typeof professional !== "string" || !professional) return "/request";
  const params = new URLSearchParams({ professional });
  const id = session.sourceSessionId ?? session.id;
  if (
    typeof id === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(session.date ?? "")
  ) {
    params.set("date", session.date);
    params.set("session", id);
    if (session.startTime && session.endTime) {
      params.set("start", session.startTime);
      params.set("end", session.endTime);
    }
  }
  return `/request?${params}`;
}

export function preselectionDate(search) {
  const params = new URLSearchParams(search);
  const date = params.get("date");
  if (
    [...params.keys()].some(
      (k) => !["professional", "date", "session", "start", "end"].includes(k),
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
