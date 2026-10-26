// Synthetic fixtures only; all operational changes use the actual guarded API.
export async function signInSynthetic(fixture, roles = ["Admin"], username) {
  const person = await fixture.account({
    roles,
    username,
    mfa: roles.some((r) => !r.includes("Receptionist")),
  });
  const ok = (r) => {
    if (r.status !== 200) throw new Error("Synthetic sign-in failed");
    return r.body;
  };
  let result = ok(
    await fixture.request("/auth/login", {
      method: "POST",
      body: { username: person.username, password: person.password },
    }),
  );
  if (!result.token)
    result = ok(
      await fixture.request("/mfa/complete", {
        method: "POST",
        body: {
          challenge: result.challenge,
          code: await fixture.totp(person.secret),
        },
      }),
    );
  return { ...person, ...result };
}
export async function seedPublicationAuthority(
  fixture,
  username,
  { imported = false } = {},
) {
  const admin = await signInSynthetic(fixture, ["Admin"], username);
  const ok = (r) => {
    if (r.status !== 200)
      throw new Error(
        `Synthetic operational fixture failed: ${r.body?.error?.code ?? r.status}`,
      );
    return r.body;
  };
  const post = (action, body, token = admin.token) =>
    fixture.request(`/operations/${action}`, { method: "POST", token, body });
  const save = async (type, record, expectedRevision = 0) =>
    ok(await post("save", { type, record, expectedRevision }));
  const state = async () =>
    ok(await fixture.request("/operations", { token: admin.token }));
  if (!imported)
    await save("scopes", {
      id: "clinic:synthetic",
      name: "Synthetic Review Clinic",
      kind: "clinic",
      active: true,
    });
  const savedProfile = imported
    ? await fixture.db.collection("doctor_profile_drafts").findOne({})
    : null;
  const profile = savedProfile
    ? Object.fromEntries(
        ["id", "name", "specialty", "kind", "gender", "active", "scopeIds"].map(
          (key) => [key, savedProfile[key]],
        ),
      )
    : {
        id: "doctor:synthetic",
        name: "Dr. Synthetic Review",
        specialty: "Dentistry",
        kind: "doctor",
        gender: "male",
        active: true,
        scopeIds: ["clinic:synthetic"],
      };
  if (!imported) await save("professionals", profile);
  if (!imported)
    await save("sessions", {
      id: "session:synthetic",
      scopeId: "clinic:synthetic",
      professionalId: profile.id,
      weekday: 1,
      startTime: "09:00",
      endTime: "11:00",
      capacity: 4,
      status: "active",
      appointmentRequired: false,
    });
  for (let day = 0; !imported && day < 7; day++)
    await save("hours", {
      id: String(day),
      closed: day === 0,
      ...(day ? { startTime: "08:00", endTime: "17:00" } : {}),
    });
  const publish = async (
    date = "2026-01-01",
    scopeIds = ["clinic:synthetic"],
  ) => {
    const s = await state();
    return post("publish", {
      scopeIds,
      expectedRevision: s.revision,
      expectedHead: s.head,
      effectiveFrom: date,
      confirmed: true,
    });
  };
  return { admin, profile, save, state, publish, post, ok };
}
