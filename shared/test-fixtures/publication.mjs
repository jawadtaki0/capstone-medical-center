export function publicationEvent(sequence = 1, effectiveFrom = "2026-01-01") {
  return {
    id: `publication:${sequence}`,
    sequence,
    effectiveFrom,
    publishedAt: "2026-01-01T08:00:00.000Z",
    scopeIds: ["clinic:synthetic"],
    publishesHours: true,
    scopes: [
      {
        id: "clinic:synthetic",
        name: "Synthetic Review Clinic",
        kind: "clinic",
        active: true,
      },
    ],
    professionals: [
      {
        id: "doctor:synthetic",
        name: "Dr. Synthetic Review",
        specialty: "Dentistry",
        kind: "doctor",
        gender: "neutral",
        active: true,
        scopeIds: ["clinic:synthetic"],
        revision: 1,
      },
    ],
    sessions: [
      {
        id: "session:synthetic",
        scopeId: "clinic:synthetic",
        professionalId: "doctor:synthetic",
        weekday: 1,
        startTime: "09:00",
        endTime: "11:00",
        capacity: 5,
        status: "active",
        appointmentRequired: false,
      },
    ],
    exceptions: [],
    hours: Array.from({ length: 7 }, (_, day) => ({
      id: String(day),
      closed: day === 0,
      ...(day ? { startTime: "08:00", endTime: "17:00" } : {}),
    })),
  };
}
