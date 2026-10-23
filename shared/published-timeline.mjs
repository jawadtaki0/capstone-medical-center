// Inputs are validated publications and center-local YYYY-MM-DD dates.
function effectiveSessions(sessions, exceptions, date) {
  const changes = exceptions.filter((entry) => entry.date === date);
  const replaced = new Set(changes.map((entry) => entry.scopeId));
  return [
    ...sessions.filter(
      (entry) =>
        entry.weekday === new Date(`${date}T12:00:00Z`).getUTCDay() &&
        !replaced.has(entry.scopeId),
    ),
    ...changes.flatMap((entry) => (entry.closed ? [] : entry.sessions)),
  ];
}
export function composePublications(events, date) {
  const selected = events
    .filter((event) => event.effectiveFrom <= date)
    .sort(
      (a, b) =>
        a.effectiveFrom.localeCompare(b.effectiveFrom) ||
        a.sequence - b.sequence,
    );
  if (!selected.length) return null;
  let result = {
    scopes: [],
    professionals: [],
    sessions: [],
    exceptions: [],
    hours: [],
  };
  for (const event of selected) {
    const ids = new Set(event.scopeIds);
    const replace = (key) => [
      ...result[key].filter(
        (record) => !ids.has(key === "scopes" ? record.id : record.scopeId),
      ),
      ...event[key].filter((record) =>
        ids.has(key === "scopes" ? record.id : record.scopeId),
      ),
    ];
    const professionals = [...result.professionals];
    for (const profile of event.professionals.filter((p) =>
      p.scopeIds.every((id) => ids.has(id)),
    )) {
      const index = professionals.findIndex((p) => p.id === profile.id);
      if (index === -1) professionals.push(profile);
      else professionals[index] = profile;
    }
    result = {
      id: event.id,
      sequence: event.sequence,
      effectiveFrom: event.effectiveFrom,
      publishedAt: event.publishedAt,
      scopes: replace("scopes"),
      professionals,
      sessions: replace("sessions"),
      exceptions: replace("exceptions"),
      hours: event.publishesHours ? event.hours : result.hours,
    };
  }
  return result;
}
// Read-only adapter shared by staff previews and the accepted TEST receiver.
// Runs the exact existing public readers; never an Atlas writer or transport.
export function publicSnapshotDatabase(snapshot, purpose = "directory") {
  const cancelledProfiles = new Set(
    [...snapshot.sessions, ...snapshot.exceptions.flatMap((e) => e.sessions)]
      .filter((s) => s.status === "cancelled")
      .map((s) => s.professionalId),
  );
  const profiles = (kind) =>
    snapshot.professionals
      .filter((p) => p.kind === kind)
      .map((p) => ({
        _id: p.id,
        name: p.name,
        specialty: p.specialty,
        gender: p.avatarVariant ?? p.gender,
        active:
          p.active || (purpose === "schedule" && cancelledProfiles.has(p.id)),
      }));
  const day = (sessions, weekday, date) => {
    const hours =
      snapshot.hours.find((h) => h.id === date) ??
      snapshot.hours.find((h) => h.id === String(weekday));
    if (hours.closed)
      return {
        closed: true,
        centerHours: null,
        doctorSessions: [],
        specialistSessions: [],
        otherServices: [],
      };
    const common = (s) => ({
      id: s.id,
      startTime: s.startTime,
      endTime: s.endTime,
      status: s.status,
      appointmentRequired: s.appointmentRequired,
    });
    const professional = (kind) =>
      sessions
        .filter((s) =>
          snapshot.professionals.some(
            (p) => p.id === s.professionalId && p.kind === kind,
          ),
        )
        .map((s) => ({
          ...common(s),
          [kind === "doctor" ? "doctorId" : "specialistId"]: s.professionalId,
        }));
    return {
      closed: false,
      centerHours: { startTime: hours.startTime, endTime: hours.endTime },
      doctorSessions: professional("doctor"),
      specialistSessions: professional("specialist"),
      otherServices: sessions
        .filter((s) => s.professionalId === null)
        .map((s) => ({
          ...common(s),
          name: snapshot.scopes.find((scope) => scope.id === s.scopeId).name,
        })),
    };
  };
  const weeklyId = `weekly:${snapshot.id}`;
  const records = {
    doctor_profiles: profiles("doctor"),
    specialist_profiles: profiles("specialist"),
    weekly_schedules: [
      {
        _id: weeklyId,
        effectiveFrom: snapshot.effectiveFrom,
        publishedAt: snapshot.publishedAt,
        publicationStatus: "published",
        days: Object.fromEntries(
          Array.from({ length: 7 }, (_, weekday) => [
            weekday,
            day(
              snapshot.sessions.filter((s) => s.weekday === weekday),
              weekday,
            ),
          ]),
        ),
      },
    ],
    schedule_date_changes: [
      ...new Set([
        ...snapshot.exceptions.map((e) => e.date),
        ...snapshot.hours.filter((h) => !/^[0-6]$/.test(h.id)).map((h) => h.id),
      ]),
    ].map((date) => ({
      _id: `date:${snapshot.id}:${date}`,
      weeklyScheduleId: weeklyId,
      date,
      publicationStatus: "published",
      publishedAt: snapshot.publishedAt,
      day: day(
        effectiveSessions(snapshot.sessions, snapshot.exceptions, date),
        new Date(`${date}T12:00:00Z`).getUTCDay(),
        date,
      ),
    })),
  };
  const matches = (record, query) =>
    Object.entries(query).every(([key, expected]) =>
      key === "$or"
        ? expected.some((q) => matches(record, q))
        : expected && typeof expected === "object"
          ? "$in" in expected
            ? expected.$in.includes(record[key])
            : "$lte" in expected && record[key] <= expected.$lte
          : record[key] === expected,
    );
  return {
    collection(name) {
      if (!Object.hasOwn(records, name))
        throw new Error("Unsupported public snapshot collection.");
      return {
        async findOne(query) {
          return structuredClone(
            records[name].find((r) => matches(r, query)) ?? null,
          );
        },
        find(query, { projection } = {}) {
          return {
            async toArray() {
              return records[name]
                .filter((r) => matches(r, query))
                .map((r) =>
                  structuredClone(
                    projection
                      ? Object.fromEntries(
                          Object.keys(projection)
                            .filter((k) => projection[k] && Object.hasOwn(r, k))
                            .map((k) => [k, r[k]]),
                        )
                      : r,
                  ),
                );
            },
          };
        },
      };
    },
  };
}
