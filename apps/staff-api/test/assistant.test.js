import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { createSecurityFixture } from "./helpers/security-fixture.js";
import {
  seedPublicationAuthority,
  signInSynthetic,
} from "./helpers/publication-authority.js";
import { beirutClock } from "../src/booking-model.js";

let f, authority, date;
const ask = (token, body) =>
  f.request("/assistant/message", { method: "POST", token, body });
const good = (r) => {
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
};
before(async () => {
  f = await createSecurityFixture();
});
beforeEach(async () => {
  await f.reset();
  authority = await seedPublicationAuthority(f);
  const monday = new Date(`${beirutClock(f.clock()).date}T12:00:00Z`);
  monday.setUTCDate(monday.getUTCDate() + ((8 - monday.getUTCDay()) % 7 || 7));
  date = monday.toISOString().slice(0, 10);
  good(await authority.publish(null));
});
after(async () => {
  if (f) {
    await f.reset();
    await f.close();
  }
});

test("requires a signed-in staff session", async () => {
  const result = await f.request("/assistant/message", {
    method: "POST",
    body: { topic: "capabilities" },
  });
  assert.equal(result.status, 401);
});

test("session facts come from the booking service for the asked date", async () => {
  const body = good(
    await ask(authority.admin.token, { topic: "sessions", date }),
  );
  const direct = good(
    await f.request("/bookings/sessions", {
      method: "POST",
      token: authority.admin.token,
      body: { date },
    }),
  );
  assert.equal(body.kind, "sessions");
  assert.equal(body.date, date);
  assert.deepEqual(
    body.sessions.map((s) => [s.professionalName, s.startTime, s.remaining]),
    direct.sessions.map((s) => [s.professionalName, s.startTime, s.remaining]),
  );
  assert.equal(body.sessions.length, 1);
});

test("a role without session access gets no session facts", async () => {
  for (const roles of [["Lab Admin"], ["Receptionist"]]) {
    // Neither synthetic account has a clinic assignment.
    const person = await signInSynthetic(f, roles);
    const body = good(await ask(person.token, { topic: "sessions", date }));
    assert.equal(body.kind, "denied", roles[0]);
    assert.equal(body.sessions, undefined);
    assert.deepEqual(body.actions, []);
  }
});

test("replies in the chosen language", async () => {
  const body = good(
    await ask(authority.admin.token, {
      topic: "patient_help",
      language: "ar",
    }),
  );
  assert.equal(body.language, "ar");
  assert.match(body.reply, /\p{Script=Arabic}/u);
});

test("refuses unknown fields, history and oversized text", async () => {
  for (const body of [
    { text: "hello", history: ["earlier"] },
    { text: "x".repeat(501) },
    { topic: "not_a_topic" },
    {},
  ]) {
    const result = await ask(authority.admin.token, body);
    assert.equal(result.status, 400, JSON.stringify(body).slice(0, 60));
  }
});

test("asking changes nothing", async () => {
  const count = async () =>
    Promise.all(
      ["patients", "bookings", "booking_changes", "lab_orders"].map((name) =>
        f.db.collection(name).countDocuments(),
      ),
    );
  const before = await count();
  good(await ask(authority.admin.token, { topic: "book_help" }));
  good(await ask(authority.admin.token, { topic: "sessions", date }));
  assert.deepEqual(await count(), before);
});

test("a booking request only pre-fills a form and writes nothing", async () => {
  const body = good(
    await ask(authority.admin.token, {
      text: "book Sami Haddad born 1988-07-04 with Dr. Synthetic on monday",
    }),
  );
  assert.equal(body.task.type, "book");
  assert.equal(body.task.prefill.firstName, "Sami");
  assert.equal(body.task.prefill.date, date);
  assert.equal(body.task.prefill.professionalId, authority.profile.id);
  assert.equal(await f.db.collection("patients").countDocuments(), 0);
  assert.equal(await f.db.collection("bookings").countDocuments(), 0);
});

test("a role that cannot book gets no booking form or alternatives", async () => {
  const lab = await signInSynthetic(f, ["Lab Admin"]);
  const body = good(
    await ask(lab.token, { text: "book an appointment for Sami Haddad" }),
  );
  assert.equal(body.kind, "denied");
  assert.equal(body.task, undefined);
  const alternatives = await f.request("/assistant/alternatives", {
    method: "POST",
    token: lab.token,
    body: { professionalId: authority.profile.id, date },
  });
  assert.equal(alternatives.status, 403);
});

test("a full session offers the same doctor's later sessions with places", async () => {
  await f.db.collection("booking_limits").deleteMany({});
  const sessions = good(
    await f.request("/bookings/sessions", {
      method: "POST",
      token: authority.admin.token,
      body: { date },
    }),
  ).sessions;
  const full = sessions[0];
  await f.db.collection("bookings").insertMany(
    Array.from({ length: full.capacity }, (_, i) => ({
      _id: `synthetic-full-${i}`,
      id: `synthetic-full-${i}`,
      bookingNumber: `B-9000000${i}`,
      actorId: "synthetic",
      idempotencyKey: `synthetic-${i}`,
      datedSessionId: full.id,
      patientId: `synthetic-patient-${i}`,
      date,
      status: "confirmed",
    })),
  );
  const body = good(
    await f.request("/assistant/alternatives", {
      method: "POST",
      token: authority.admin.token,
      body: { professionalId: full.professionalId, date },
    }),
  );
  assert.ok(body.sessions.length > 0);
  for (const s of body.sessions) {
    assert.equal(s.professionalId, full.professionalId);
    assert.ok(s.remaining > 0);
    assert.notEqual(s.id, full.id);
  }
});
