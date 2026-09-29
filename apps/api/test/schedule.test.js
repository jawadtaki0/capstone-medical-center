import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.js";
import { getBeirutToday, getScheduleForDate, isValidScheduleDate } from "../src/schedule.js";

test("weekly doctor sessions recur on the same weekday", () => {
  const first = getScheduleForDate("2026-09-28");
  const next = getScheduleForDate("2026-10-05");
  const fields = ({ id, startTime, endTime }) => ({ id, startTime, endTime });
  assert.deepEqual(first.doctorSessions.map(fields), next.doctorSessions.map(fields));
  assert.equal(first.doctorSessions.length, 2);
  assert.equal(first.timeZone, "Asia/Beirut");
  assert.equal(first.sampleData, true);
});

test("a one-date time change does not alter the weekly session", () => {
  const changed = getScheduleForDate("2026-10-02").doctorSessions[0];
  const next = getScheduleForDate("2026-10-09").doctorSessions[0];
  assert.equal(changed.id, "hadi-friday");
  assert.equal(changed.startTime, "11:00");
  assert.equal(changed.endTime, "13:00");
  assert.equal(next.startTime, "09:00");
  assert.equal(next.endTime, "11:00");
});

test("a cancellation affects one date only", () => {
  const status = (date) => getScheduleForDate(date).doctorSessions
    .find((session) => session.id === "maya-thursday")?.status;
  assert.equal(status("2026-10-01"), "cancelled");
  assert.equal(status("2026-10-08"), "active");
});

test("invalid calendar dates are rejected", () => {
  for (const value of ["2026-02-30", "2026-13-01", "09/29/2026", "", "2026-9-29"]) {
    assert.equal(isValidScheduleDate(value), false);
    assert.throws(() => getScheduleForDate(value), RangeError);
  }
  assert.equal(isValidScheduleDate("2026-09-29"), true);
});

test("an unscheduled Sunday is empty", () => {
  const schedule = getScheduleForDate("2026-10-04");
  assert.deepEqual(schedule.doctorSessions, []);
  assert.deepEqual(schedule.otherServices, []);
});

test("other services appear only on scheduled weekdays", () => {
  const names = (date) => getScheduleForDate(date).otherServices.map(({ name }) => name);
  assert.deepEqual(names("2026-09-29"), ["Laboratory", "Audiometry"]);
  assert.deepEqual(names("2026-09-28"), ["Laboratory"]);
});

async function apiResponse(context, path) {
  const server = createApp().listen(0);
  context.after(() => server.close());
  await new Promise((resolve) => server.once("listening", resolve));
  const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`);
  return { status: response.status, body: await response.json() };
}

test("the public API returns a dated schedule with no capacity", async (context) => {
  const { status, body } = await apiResponse(context, "/api/schedule?date=2026-10-01");
  assert.equal(status, 200);
  assert.equal(body.date, "2026-10-01");
  assert.equal(body.timeZone, "Asia/Beirut");
  assert.equal(body.doctorSessions.length, 2);
  assert.equal(body.doctorSessions.find(({ id }) => id === "maya-thursday")?.status, "cancelled");
  assert.equal(Object.hasOwn(body.doctorSessions[0], "capacity"), false);
});

test("the public API rejects invalid dates", async (context) => {
  const { status, body } = await apiResponse(context, "/api/schedule?date=2026-02-30");
  assert.equal(status, 400);
  assert.equal(body.error, "invalid_date");
});

test("the public API defaults to today's Beirut date", async (context) => {
  const { status, body } = await apiResponse(context, "/api/schedule");
  assert.equal(status, 200);
  assert.equal(body.date, getBeirutToday());
});
