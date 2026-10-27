import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { createSecurityFixture } from "./helpers/security-fixture.js";
import {
  signInSynthetic,
  seedPublicationAuthority,
} from "./helpers/publication-authority.js";
import {
  patientNameSignatures,
  nameKey,
} from "../../staff/shared/patient-input.js";
import { randomUUID } from "node:crypto";
import { buildDelivery } from "../../../shared/publication-contract.mjs";
import { syntheticBaselineSnapshot } from "./helpers/public-baseline.js";
import { planPublicBaseline } from "../src/public-baseline-import.js";
let f;
before(async () => {
  f = await createSecurityFixture();
});
beforeEach(async () => {
  await f.reset();
});
after(async () => {
  if (f) {
    await f.reset();
    await f.close();
  }
});
const person = (extra = {}) => ({
  firstName: "Synthetic",
  fatherName: "Father",
  lastName: "Example",
  motherFirstName: "Mother",
  dateOfBirth: "2000-02-29",
  phone: "+96171123456",
  gender: "female",
  ...extra,
});
const post = (action, token, body) =>
  f.request(`/patients/${action}`, { method: "POST", token, body });
async function save(token, record = person(), override) {
  const check = await post("check", token, { record });
  assert.equal(check.status, 200);
  return post("create", token, {
    record,
    reviewDigest: check.body.reviewDigest,
    ...(override ? { duplicateOverride: override } : {}),
  });
}
test("all four roles and mixed roles can create/search/edit a basic record; numbers are server generated and immutable", async () => {
  for (const roles of [
    ["Admin"],
    ["Clinic Admin"],
    ["Lab Admin"],
    ["Receptionist"],
    ["Clinic Admin", "Lab Admin"],
  ]) {
    const actor = await signInSynthetic(f, roles);
    const record = person({
      firstName: `Synthetic ${["One", "Two", "Three", "Four", "Five"][roles[0] === "Admin" ? 0 : roles.length === 2 ? 4 : ["Clinic Admin", "Lab Admin", "Receptionist"].indexOf(roles[0]) + 1]}`,
    });
    const created = await save(actor.token, record);
    assert.equal(created.status, 200);
    assert.ok(created.body.patient.patientNumber.startsWith("P-"));
    const patient = created.body.patient;
    const edited = await post("update", actor.token, {
      patientId: patient.id,
      expectedRevision: patient.revision,
      record: { ...record, phone: "+96176123456" },
      reviewDigest: (
        await post("check", actor.token, {
          patientId: patient.id,
          expectedRevision: patient.revision,
          record: { ...record, phone: "+96176123456" },
        })
      ).body.reviewDigest,
      duplicateOverride: {
        acknowledged: true,
        reason: "Synthetic distinct patient review",
      },
    });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.patient.patientNumber, patient.patientNumber);
  }
  const actor = await signInSynthetic(f);
  const found = await post("search", actor.token, {
    firstName: "  SYNTHETIC  ",
  });
  assert.equal(found.status, 200);
  assert.equal(found.body.patients.length, 5);
});
test("required fields, forbidden input, expired/disabled/unknown-role callers fail without patient writes", async () => {
  const actor = await signInSynthetic(f);
  for (const field of Object.keys(person())) {
    const bad = await post("check", actor.token, {
      record: person({ [field]: "" }),
    });
    assert.equal(bad.status, 400);
  }
  for (const record of [
    person({ dateOfBirth: "2001-02-29" }),
    person({ dateOfBirth: "2999-01-01" }),
    { ...person(), patientNumber: "P-12345678" },
  ])
    assert.equal((await post("create", actor.token, { record })).status, 400);
  assert.equal(
    (await post("search", undefined, { firstName: "Synthetic" })).status,
    401,
  );
  await f.db
    .collection("accounts")
    .updateOne({ _id: actor.id }, { $set: { roles: ["Unknown"] } });
  assert.equal(
    (await post("search", actor.token, { firstName: "Synthetic" })).status,
    401,
  );
  await f.db
    .collection("accounts")
    .updateOne(
      { _id: actor.id },
      { $set: { roles: ["Admin"], status: "disabled" } },
    );
  assert.equal((await saveCheckOnly(actor.token)).status, 401);
  assert.equal(await f.db.collection("patients").countDocuments(), 0);
});
function saveCheckOnly(token) {
  return post("check", token, { record: person() });
}
test("duplicate warning/override preserves records, explicit dates, shared phones and private audit evidence", async () => {
  const actor = await signInSynthetic(f);
  const first = await save(actor.token);
  assert.equal(first.status, 200);
  const check = await post("check", actor.token, {
    record: person({ firstName: " synthetic " }),
  });
  assert.equal(check.body.candidates[0].classification, "strong");
  const refused = await post("create", actor.token, {
    record: person({ firstName: " synthetic " }),
    reviewDigest: check.body.reviewDigest,
  });
  assert.equal(refused.body.reviewRequired, true);
  assert.equal(await f.db.collection("patients").countDocuments(), 1);
  const second = await save(
    actor.token,
    person({ dateOfBirth: "2001-02-28" }),
    {
      acknowledged: true,
      reason: "Synthetic twins or distinct family members",
    },
  );
  assert.equal(second.status, 200);
  assert.notEqual(
    first.body.patient.patientNumber,
    second.body.patient.patientNumber,
  );
  const warning = await post("check", actor.token, {
    record: person({ dateOfBirth: "2001-02-28" }),
  });
  assert.equal(
    warning.body.candidates.find((p) => p.id === first.body.patient.id)
      .classification,
    "possible",
  );
  assert.equal(
    warning.body.candidates.find((p) => p.id === first.body.patient.id)
      .dateDiscrepancy.existing,
    "2000-02-29",
  );
  const audit = await f.db
    .collection("patient_changes")
    .findOne({ action: "create", patientId: second.body.patient.id });
  assert.equal(audit.actorId, actor.id);
  assert.ok(audit.duplicateReview.reason);
  assert.ok(audit.changes.motherFirstName);
  const events = await f.db
    .collection("security_events")
    .find({ action: /^patient_/ })
    .toArray();
  assert.equal(JSON.stringify(events).includes(person().phone), false);
});
test("simultaneous identical registration forces a fresh duplicate review; acknowledged distinct records get unique numbers", async () => {
  const actor = await signInSynthetic(f),
    record = person();
  const review = (await post("check", actor.token, { record })).body;
  const outcomes = await Promise.all([
    post("create", actor.token, { record, reviewDigest: review.reviewDigest }),
    post("create", actor.token, { record, reviewDigest: review.reviewDigest }),
  ]);
  assert.equal(outcomes.filter((r) => r.body.patient).length, 1);
  assert.equal(outcomes.filter((r) => r.body.reviewRequired).length, 1);
  assert.equal(await f.db.collection("patients").countDocuments(), 1);
  const other = await save(actor.token, record, {
    acknowledged: true,
    reason: "Confirmed synthetic distinct person",
  });
  assert.equal(other.status, 200);
  assert.equal(await f.db.collection("patients").countDocuments(), 2);
  const numbers = (await f.db.collection("patients").find({}).toArray()).map(
    (p) => p.patientNumber,
  );
  assert.equal(new Set(numbers).size, 2);
  await assert.rejects(
    f.db
      .collection("patients")
      .insertOne({ _id: "synthetic-collision", patientNumber: numbers[0] }),
    (e) => e.code === 11000,
  );
});
test("stale edits and changed candidate reviews cannot overwrite records; audit failure rolls back", async () => {
  const actor = await signInSynthetic(f),
    created = (await save(actor.token)).body.patient;
  const record = person({ fatherName: "Updated Father" }),
    check = (
      await post("check", actor.token, {
        patientId: created.id,
        expectedRevision: created.revision,
        record,
      })
    ).body;
  const input = {
    patientId: created.id,
    expectedRevision: created.revision,
    record,
    reviewDigest: check.reviewDigest,
  };
  assert.equal((await post("update", actor.token, input)).status, 200);
  assert.equal((await post("update", actor.token, input)).status, 409);
  const before = await f.db.collection("patients").findOne({ _id: created.id });
  assert.equal(before.fatherName, "Updated Father");
  const counter = await f.db
    .collection("patient_registry_state")
    .findOne({ _id: "registry" });
  await f.restart({ failAudit: true });
  // The established synthetic audit failure occurs after real Mongo writes.
  assert.equal(
    (await save(actor.token, person({ lastName: "Unrelated" }))).status,
    503,
  );
  assert.equal(await f.db.collection("patients").countDocuments(), 1);
  assert.deepEqual(
    await f.db
      .collection("patient_registry_state")
      .findOne({ _id: "registry" }),
    counter,
  );
  await f.restart({ reconnect: true });
});
test("indexed paginated search, restart persistence and public projection exclude patient information", async () => {
  const actor = await signInSynthetic(f);
  await save(actor.token);
  assert.equal((await post("search", actor.token, {})).status, 400);
  assert.equal(
    (await post("search", actor.token, { firstName: { $ne: null } })).status,
    400,
  );
  await f.restart({ reconnect: true });
  const result = await post("search", actor.token, { phone: "+96171123456" });
  assert.equal(result.status, 200);
  assert.equal(result.body.patients.length, 1);
  const plan = planPublicBaseline(syntheticBaselineSnapshot());
  const event = {
    id: "publication:1",
    sequence: 1,
    effectiveFrom: null,
    publishedAt: "2026-01-01T00:00:00.000Z",
    scopeIds: plan.collections.operational_scopes.map((s) => s.id),
    publishesHours: true,
    scopes: plan.collections.operational_scopes,
    professionals: plan.collections.doctor_profile_drafts,
    sessions: plan.collections.operational_session_drafts,
    exceptions: [],
    hours: plan.collections.operational_hours_drafts,
  };
  const payload = buildDelivery("stream:synthetic-patient-exclusion", [event]);
  assert.equal(JSON.stringify(payload).includes("motherFirstName"), false);
  assert.equal(JSON.stringify(payload).includes(person().phone), false);
  assert.equal(
    (
      await post("create", actor.token, {
        record: person(),
        patientNumber: "P-FAKE",
      })
    ).status,
    400,
  );
});

test("bounded keyset pages cover all records without duplicates; name fields and exact phone remain separate", async () => {
  const actor = await signInSynthetic(f, ["Receptionist"]);
  // Isolated fixture writes exercise paging without unrelated UI registrations.
  const rows = Array.from({ length: 24 }, (_, i) => {
    const record = person({
      firstName: "Page Synthetic",
      fatherName: i % 2 ? "First Father" : "Second Father",
    });
    return {
      _id: randomUUID(),
      ...record,
      patientNumber: `P-${String(i + 1).padStart(8, "0")}`,
      revision: 1,
      keys: Object.fromEntries(
        ["firstName", "fatherName", "lastName", "motherFirstName"].map((k) => [
          k,
          nameKey(record[k]),
        ]),
      ),
      firstSignatures: patientNameSignatures(record.firstName),
      lastSignatures: patientNameSignatures(record.lastName),
    };
  });
  await f.db.collection("patients").insertMany(rows);
  const first = await post("search", actor.token, { firstName: "  PAGE  " });
  assert.equal(first.body.patients.length, 20);
  assert.ok(first.body.nextCursor);
  const second = await post("search", actor.token, {
    firstName: "Page",
    cursor: first.body.nextCursor,
  });
  assert.equal(second.body.patients.length, 4);
  assert.equal(second.body.nextCursor, null);
  assert.equal(
    new Set([...first.body.patients, ...second.body.patients].map((p) => p.id))
      .size,
    24,
  );
  assert.equal(
    (await post("search", actor.token, { fatherName: "First" })).body.patients
      .length,
    12,
  );
  assert.equal(
    (await post("search", actor.token, { firstName: "First" })).body.patients
      .length,
    0,
  );
  for (const body of [
    { firstName: "P" },
    { firstName: "Page", cursor: { $gt: "" } },
    { patientNumber: ".*" },
    { dateOfBirth: "2001-02-29" },
  ])
    assert.equal((await post("search", actor.token, body)).status, 400);
  const plan = await f.db
    .collection("patients")
    .find({ "keys.firstName": { $gte: "page", $lt: "page\uffff" } })
    .explain("queryPlanner");
  assert.ok(JSON.stringify(plan.queryPlanner.winningPlan).includes("IXSCAN"));
});

test("a changed registry invalidates acknowledgement; cancellation and failed saves do not allocate numbers", async () => {
  const actor = await signInSynthetic(f),
    record = person(),
    old = (await post("check", actor.token, { record })).body;
  assert.equal(await f.db.collection("patients").countDocuments(), 0); // Closing after check writes nothing.
  await save(actor.token, person({ firstName: "Unrelated" }));
  const late = await post("create", actor.token, {
    record,
    reviewDigest: old.reviewDigest,
  });
  assert.equal(late.body.reviewRequired, true);
  assert.equal(await f.db.collection("patients").countDocuments(), 1);
  // The returned fresh review is usable; an invalidated review cannot loop forever.
  assert.ok(
    (
      await post("create", actor.token, {
        record,
        reviewDigest: late.body.reviewDigest,
      })
    ).body.patient,
  );
  const review = (await post("check", actor.token, { record })).body;
  assert.equal(
    (
      await post("create", actor.token, {
        record,
        reviewDigest: review.reviewDigest,
        duplicateOverride: { acknowledged: true, reason: " " },
      })
    ).status,
    400,
  );
  const before = await f.db
    .collection("patient_registry_state")
    .findOne({ _id: "registry" });
  f.advance(11 * 60000);
  assert.equal(
    (
      await post("create", actor.token, {
        record,
        reviewDigest: review.reviewDigest,
        duplicateOverride: {
          acknowledged: true,
          reason: "Synthetic distinct patient",
        },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await f.db
        .collection("patient_registry_state")
        .findOne({ _id: "registry" })
    ).lastNumber,
    before.lastNumber,
  );
});

test("real publication/outbox projection never includes registry or private patient audit data", async () => {
  const setup = await seedPublicationAuthority(f);
  const created = await save(
    setup.admin.token,
    person({ firstName: "Private Patient Sentinel" }),
  );
  assert.ok(created.body.patient);
  assert.equal((await setup.publish()).status, 200);
  const published = await f.db
      .collection("operational_publications")
      .find({})
      .toArray(),
    outbox = await f.db
      .collection("public_publication_outbox")
      .find({})
      .toArray();
  assert.ok(published.length);
  assert.ok(outbox.length);
  for (const output of [published, outbox]) {
    const text = JSON.stringify(output);
    for (const privateValue of [
      "Private Patient Sentinel",
      "motherFirstName",
      person().phone,
      created.body.patient.id,
      created.body.patient.patientNumber,
    ])
      assert.equal(text.includes(privateValue), false);
  }
});

test("missing or exhausted numbering state never reuses a number or partially saves", async () => {
  const actor = await signInSynthetic(f);
  const first = await save(actor.token);
  assert.ok(first.body.patient);
  await f.db
    .collection("patient_registry_state")
    .deleteOne({ _id: "registry" });
  const second = person({ firstName: "Unrelated" });
  assert.equal((await save(actor.token, second)).status, 503);
  assert.equal(await f.db.collection("patients").countDocuments(), 1);
  assert.equal(
    await f.db.collection("patient_registry_state").countDocuments(),
    0,
  );
  await f.db.collection("patient_registry_state").insertOne({
    _id: "registry",
    lastNumber: Number.MAX_SAFE_INTEGER,
    revision: 1,
    serial: 0,
  });
  assert.equal((await save(actor.token, second)).status, 503);
  assert.equal(await f.db.collection("patients").countDocuments(), 1);
  assert.equal(
    (
      await f.db
        .collection("patient_registry_state")
        .findOne({ _id: "registry" })
    ).lastNumber,
    Number.MAX_SAFE_INTEGER,
  );
});
