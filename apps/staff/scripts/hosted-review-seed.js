import { validateOperationalRecord } from "../../staff-api/src/operational-model.js";

const fail = () =>
  new Error(
    "Hosted review source/limits require reconciliation; no data was overwritten.",
  );
const keys = {
  scopes: ["id", "name", "kind", "active"],
  professionals: [
    "id",
    "name",
    "specialty",
    "kind",
    "gender",
    "active",
    "scopeIds",
  ],
  sessions: [
    "id",
    "scopeId",
    "professionalId",
    "weekday",
    "startTime",
    "endTime",
    "capacity",
    "status",
    "appointmentRequired",
  ],
  exceptions: ["id", "scopeId", "date", "closed", "sessions"],
  hours: ["id", "closed", "startTime", "endTime"],
};
const pick = (type, row) =>
  Object.fromEntries(
    keys[type].filter((k) => Object.hasOwn(row, k)).map((k) => [k, row[k]]),
  );

// Actual published names and identifiers are supplied only by ignored private
// artifacts. The executable contains no operational records or fixed secrets.
export function prepareHostedReviewSeed(source, approved) {
  const b = source?.baseline;
  if (
    source?.schemaVersion !== 1 ||
    source.reviewOnly !== true ||
    !/^[a-f0-9]{64}$/.test(source.sourceDigest) ||
    !b ||
    !Object.keys(keys).every((k) => Array.isArray(b[k])) ||
    !Array.isArray(approved?.rows)
  )
    throw fail();
  const professionalSessions = b.sessions.filter(
    (s) => s.professionalId !== null,
  );
  if (
    b.professionals.length !== 19 ||
    professionalSessions.length !== 34 ||
    b.hours.length !== 7 ||
    b.scopes.filter((s) => s.kind === "clinic").length !== 1 ||
    b.scopes.filter((s) => s.kind === "service").length !== 2 ||
    professionalSessions.filter((s) => s.appointmentRequired).length !== 9 ||
    !b.professionals.every((p) => ["male", "female"].includes(p.gender)) ||
    approved.rows.length !== 34
  )
    throw fail();
  const limits = new Map(approved.rows.map((row) => [row.sessionId, row]));
  if (limits.size !== 34) throw fail();
  function session(row) {
    const result = pick("sessions", row);
    if (row.professionalId === null) result.capacity = null;
    else {
      const selected = limits.get(row.id);
      if (
        !selected ||
        ![
          "professionalId",
          "weekday",
          "startTime",
          "endTime",
          "appointmentRequired",
        ].every((k) => selected[k] === row[k]) ||
        !Number.isSafeInteger(selected.capacity) ||
        selected.capacity < 1
      )
        throw fail();
      result.capacity = selected.capacity;
    }
    return validateOperationalRecord("sessions", result);
  }
  const records = Object.fromEntries(
    Object.keys(keys).map((type) => [
      type,
      b[type].map((row) => {
        if (type === "sessions") return session(row);
        const value = pick(type, row);
        if (type === "exceptions") {
          // This reviewed starting inventory has no dated overrides. Do not invent
          // a limit inheritance/copying rule if that source changes later.
          if (value.sessions?.length) throw fail();
          value.sessions = [];
        }
        return validateOperationalRecord(type, value);
      }),
    ]),
  );
  for (const type of Object.keys(keys))
    if (new Set(records[type].map((r) => r.id)).size !== records[type].length)
      throw fail();
  return {
    records,
    sourceDigest: source.sourceDigest,
    clinicId: records.scopes.find((s) => s.kind === "clinic").id,
  };
}

export function assertHostedSeedLedger(ledger, identity) {
  if (!ledger) return false;
  if (
    ledger.version !== 1 ||
    ledger.status !== "complete" ||
    !["sourceDigest", "configDigest", "streamId"].every(
      (k) => ledger[k] === identity[k],
    )
  )
    throw fail();
  return true;
}

export async function seedHostedReview(
  fixture,
  { source, approved, identity, saveAccess },
) {
  const prepared = prepareHostedReviewSeed(source, approved);
  const ledger = fixture.db.collection("hosted_seed_state");
  if (
    assertHostedSeedLedger(await ledger.findOne({ _id: "baseline" }), identity)
  )
    return { reused: true };
  const { STAFF_COLLECTIONS } =
    await import("../../staff-api/test/helpers/security-fixture.js");
  for (const name of STAFF_COLLECTIONS) {
    if (
      name !== "staff_management_state" &&
      (await fixture.db
        .collection(name)
        .findOne({}, { projection: { _id: 1 } }))
    )
      throw fail();
  }
  // First claim fails closed after interruption. It never resets partially
  // created accounts or records; an operator must inspect/reconcile that case.
  await ledger.insertOne({
    _id: "baseline",
    version: 1,
    status: "initializing",
    ...identity,
  });
  await fixture.db.collection("operational_state").insertOne({
    _id: "working",
    revision: 0,
    head: 0,
    streamId: identity.streamId,
  });
  const { signInSynthetic } =
    await import("../../staff-api/test/helpers/publication-authority.js");
  const admin = await signInSynthetic(
    fixture,
    ["Admin"],
    "synthetic.hosted.admin",
  );
  const receptionist = await fixture.account({
    username: "synthetic.hosted.reception",
    roles: ["Receptionist"],
  });
  const access = (person) =>
    Object.fromEntries(
      ["id", "username", "password", "secret", "backupCodes"].map((k) => [
        k,
        person[k],
      ]),
    );
  await saveAccess({
    version: 1,
    syntheticOnly: true,
    admin: access(admin),
    receptionist: access(receptionist),
  });
  const ok = (response) => {
    if (response.status !== 200)
      throw new Error(
        `Hosted review seed API refused: ${response.body?.error?.code ?? response.status}`,
      );
    return response.body;
  };
  const post = (action, body) =>
    fixture.request(`/operations/${action}`, {
      method: "POST",
      token: admin.token,
      body,
    });
  for (const type of [
    "scopes",
    "professionals",
    "hours",
    "sessions",
    "exceptions",
  ])
    for (const record of prepared.records[type]) {
      ok(await post("save", { type, record, expectedRevision: 0 }));
    }
  ok(
    await post("grants", {
      accountId: receptionist.id,
      scopeIds: [prepared.clinicId],
      expectedRevision: 0,
      confirmed: true,
    }),
  );
  const state = ok(
    await fixture.request("/operations", { token: admin.token }),
  );
  ok(
    await post("publish", {
      scopeIds: prepared.records.scopes.map((s) => s.id),
      expectedRevision: state.revision,
      expectedHead: state.head,
      effectiveFrom: null,
      confirmed: true,
    }),
  );
  await fixture.db
    .collection("staff_sessions")
    .deleteMany({ accountId: admin.id });
  await ledger.updateOne(
    { _id: "baseline", status: "initializing" },
    { $set: { status: "complete" } },
  );
  return {
    reused: false,
    clinicId: prepared.clinicId,
    professionals: 19,
    sessions: 34,
  };
}
