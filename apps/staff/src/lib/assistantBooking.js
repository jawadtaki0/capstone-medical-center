// One confirmation covers registration (when needed) and booking. Nothing is
// sent until confirm() is called, and repeated calls cannot book twice.
export function createBookingRun({
  api,
  session,
  patient,
  registration,
  noticeLanguage = "en",
}) {
  const idempotencyKey = crypto.randomUUID();
  let saved = patient,
    current;
  async function submit() {
    if (!saved) {
      const result = await api.createPatient(registration);
      if (!result.patient) return result;
      saved = result.patient;
    }
    try {
      return await api.confirmBooking({
        patientId: saved.id,
        patientRevision: saved.revision,
        date: session.date,
        scopeId: session.scopeId,
        sourceSessionId: session.sourceSessionId,
        sessionVersion: session.version,
        idempotencyKey,
        noticeLanguage,
      });
    } catch (error) {
      if (registration) error.patientSaved = saved;
      throw error;
    }
  }
  return {
    confirm() {
      current ??= submit().then(
        (result) => {
          if (!result.booking) current = undefined;
          return result;
        },
        (error) => {
          current = undefined;
          throw error;
        },
      );
      return current;
    },
  };
}
