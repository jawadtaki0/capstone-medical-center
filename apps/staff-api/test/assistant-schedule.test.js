import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createSecurityFixture } from "./helpers/security-fixture.js";
import {
  seedPublicationAuthority,
  signInSynthetic,
} from "./helpers/publication-authority.js";
import { beirutClock } from "../src/booking-model.js";
import {
  matchProfessionals,
  readLimit,
  limitChange,
  absenceChange,
} from "../../staff/src/lib/assistantSchedule.js";

let f, authority, monday, clinic, reception;
const post = (path, person, body) =>
  f.request(path, { method: "POST", token: person.token, body });
const good = (r) => {
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
};
const state = async (person) =>
  good(await f.request("/operations", { token: person.token }));

before(async () => {
  f = await createSecurityFixture();
});
beforeEach(async () => {
  await f.reset();
  authority = await seedPublicationAuthority(f);
  clinic = await signInSynthetic(f, ["Clinic Admin"]);
  reception = await signInSynthetic(f, ["Receptionist"]);
  for (const person of [clinic, reception])
    await f.db.collection("operational_grants").insertOne({
      _id: person.id,
      id: person.id,
      scopeIds: ["clinic:synthetic"],
      revision: 1,
    });
  const day = new Date(`${beirutClock(f.clock()).date}T12:00:00Z`);
  day.setUTCDate(day.getUTCDate() + ((8 - day.getUTCDay()) % 7 || 7));
  monday = day.toISOString().slice(0, 10);
  good(await authority.publish(null));
});
after(async () => {
  if (f) {
    await f.reset();
    await f.close();
  }
});

async function book() {
  const record = {
    firstName: "Synthetic",
    fatherName: "Father",
    lastName: "Schedule",
    motherFirstName: "Mother",
    dateOfBirth: "2000-02-29",
    phone: "+96171123456",
    gender: "female",
  };
  const admin = authority.admin;
  const check = good(await post("/patients/check", admin, { record }));
  const patient = good(
    await post("/patients/create", admin, {
      record,
      reviewDigest: check.reviewDigest,
    }),
  ).patient;
  const s = good(await post("/bookings/sessions", admin, { date: monday }))
    .sessions[0];
  good(
    await post("/bookings/confirm", admin, {
      patientId: patient.id,
      patientRevision: patient.revision,
      date: monday,
      scopeId: s.scopeId,
      sourceSessionId: s.sourceSessionId,
      sessionVersion: s.version,
      idempotencyKey: randomUUID(),
    }),
  );
}

test("the doctor and numbers are only read from what was typed", () => {
  const people = [
    { id: "a", name: "Dr. Rola Reslan" },
    { id: "b", name: "Dr. Hasan Rahal" },
  ];
  assert.deepEqual(
    matchProfessionals("change dr rahal limit from 4 to 6", people),
    [people[1]],
  );
  assert.deepEqual(matchProfessionals("change the limit", people), []);
  assert.deepEqual(readLimit("limit from 4 to 6"), { from: 4, to: 6 });
  assert.deepEqual(readLimit("غير الحد من ٤ الى ٦"), { from: 4, to: 6 });
  assert.deepEqual(readLimit("set the limit to 12"), { to: 12 });
  assert.deepEqual(readLimit("absent on 2026-12-01"), {});
});

test("only clinic schedule editors get the forms", async () => {
  const lab = await signInSynthetic(f, ["Lab Admin"]);
  for (const [text, type] of [
    ["change Dr. Synthetic patient limit from 4 to 6", "limit"],
    ["make Dr. Synthetic absent on " + monday, "absence"],
  ])
    for (const [person, allowed] of [
      [authority.admin, true],
      [clinic, true],
      [reception, false],
      [lab, false],
    ]) {
      const body = good(await post("/assistant/message", person, { text }));
      assert.equal(body.task?.type, allowed ? type : undefined, text);
      if (allowed && type === "absence")
        assert.deepEqual(body.task.prefill.dates, [monday]);
    }
});

test("a limit change saves for editors and never below booked places", async () => {
  await book();
  const before = await state(clinic);
  const session = before.sessions[0];
  const input = limitChange(session, 6);
  assert.equal((await post("/operations/save", reception, input)).status, 403);
  assert.equal(
    good(await post("/operations/save", clinic, input)).patientLimitUpdated,
    true,
  );
  const listed = good(
    await post("/bookings/sessions", authority.admin, { date: monday }),
  ).sessions[0];
  assert.equal(listed.capacity, 6);
  const stale = await post("/operations/save", clinic, input);
  assert.equal(stale.status, 409);
});

test("an absence saves a draft and leaves bookings alone", async () => {
  await book();
  const current = await state(clinic);
  const input = absenceChange(current, monday, authority.profile.id);
  assert.equal(input.type, "exceptions");
  good(await post("/operations/save", clinic, input));
  assert.equal(
    await f.db.collection("bookings").countDocuments({ status: "confirmed" }),
    1,
  );
  const published = await authority.publish("2026-01-01");
  assert.equal(published.body.error.code, "booking_conflict");
});
