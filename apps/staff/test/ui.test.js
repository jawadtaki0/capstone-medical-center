import assert from "node:assert/strict";
import test from "node:test";
import { ACTIVITY_INTERVAL_MS, isForegroundActivity, observeSession, sessionTiming, shouldReportActivity } from "../src/lib/activity.js";
import { STAFF_DEPARTMENTS, setupProfile, suggestedUsername } from "../src/lib/profile.js";

test("only trusted visible foreground deliberate input counts as activity", () => {
  for (const type of ["click", "pointerdown", "touchstart", "keydown", "input", "wheel"]) {
    assert.equal(isForegroundActivity({ type, isTrusted: true, visible: true, focused: true }), true);
  }
  for (const type of ["mousemove", "pointermove", "poll", "timer", "focus", "visibilitychange", "scroll", "sessionStatus"]) {
    assert.equal(isForegroundActivity({ type, isTrusted: true, visible: true, focused: true }), false);
  }
  for (const change of [{ isTrusted: false }, { visible: false }, { focused: false }]) {
    assert.equal(isForegroundActivity({ type: "keydown", isTrusted: true, visible: true, focused: true, ...change }), false);
  }
});

test("activity reports immediately first, then at most once per thirty seconds", () => {
  const event = { type: "click", isTrusted: true, visible: true, focused: true };
  assert.equal(shouldReportActivity(event, -Infinity, 0), true);
  assert.equal(shouldReportActivity(event, 0, ACTIVITY_INTERVAL_MS - 1), false);
  assert.equal(shouldReportActivity(event, 0, ACTIVITY_INTERVAL_MS), true);
  assert.equal(shouldReportActivity({ ...event, type: "poll" }, -Infinity, 999_999), false);
});

const base = {
  serverNow: "2026-10-02T08:00:00.000Z", idleExpiresAt: "2026-10-02T08:10:00.000Z", absoluteExpiresAt: "2026-10-02T16:00:00.000Z",
};
test("session clock uses observed server time, not the computer's clock timezone or offset", () => {
  const session = observeSession(base, 1000);
  assert.deepEqual(sessionTiming(session, 1000), { expired: false, warning: false, secondsRemaining: 600 });
  assert.equal(base.observedAt, undefined);
  assert.deepEqual(sessionTiming(session, 1000 + 9 * 60_000), { expired: false, warning: true, secondsRemaining: 60 });
  assert.deepEqual(sessionTiming(session, 1000 + 10 * 60_000), { expired: true, warning: false, secondsRemaining: 0 });
});

test("absolute expiry cannot be extended by activity and malformed metadata fails closed", () => {
  const session = observeSession({ ...base, absoluteExpiresAt: "2026-10-02T08:00:10.000Z" }, 0);
  assert.equal(sessionTiming(session, 10_000).expired, true);
  for (const malformed of [null, {}, { ...base, idleExpiresAt: "invalid" }]) assert.equal(sessionTiming(malformed, 0).expired, true);
});

test("observing a session or checking background status never records deliberate activity", () => {
  const session = observeSession(base, 9000);
  assert.equal(session.observedAt, 9000);
  for (const type of ["poll", "sessionStatus", "visibilitychange", "focus"]) {
    assert.equal(shouldReportActivity({ type, isTrusted: true, visible: true, focused: true }, -Infinity, 9000), false);
  }
  assert.equal(sessionTiming(session, 9000).secondsRemaining, 600);
});

test("warning boundary is exactly the last idle minute and absolute expiry remains authoritative", () => {
  const session = observeSession(base, 0);
  assert.equal(sessionTiming(session, 9 * 60_000 - 1).warning, false);
  assert.equal(sessionTiming(session, 9 * 60_000).warning, true);
  const nearAbsolute = observeSession({ ...base, absoluteExpiresAt: "2026-10-02T08:00:05.000Z" }, 0);
  assert.deepEqual(sessionTiming(nearAbsolute, 0), { expired: false, warning: false, secondsRemaining: 5 });
  assert.equal(sessionTiming(nearAbsolute, 5000).expired, true);
});

test("username suggestions are deterministic and do not incorporate private family/birth fields", () => {
  assert.equal(suggestedUsername("Sample", "Person"), "sample.person");
  assert.equal(suggestedUsername(" Éxample ", " O’Test "), "example.otest");
  assert.equal(suggestedUsername("", ""), "");
});

test("setup profile sends only agreed profile fields and one university qualification", () => {
  const data = new FormData();
  for (const [key, value] of Object.entries({ firstName: " Example ", lastName: "Person", fatherName: "Parent", motherName: "Parent", dateOfBirth: "1990-01-01", address: "Synthetic address", phone: "synthetic-only", email: "synthetic@example.invalid", employmentStartDate: "2026-10-02", qualificationTitle: "Synthetic university qualification", qualificationInstitution: "Example institution", password: "must not be included", role: "must not be included" })) data.append(key, value);
  data.append("departments", "Clinic"); data.append("departments", "Administration");
  const result = setupProfile(data);
  assert.equal(result.firstName, "Example");
  assert.deepEqual(result.departments, ["Clinic", "Administration"]);
  assert.deepEqual(result.qualification, { type: "university", title: "Synthetic university qualification", institution: "Example institution" });
  assert.equal(Object.hasOwn(result, "password"), false);
  assert.equal(Object.hasOwn(result, "role"), false);
  assert.deepEqual(STAFF_DEPARTMENTS, ["Clinic", "Laboratory", "Administration"]);
});
