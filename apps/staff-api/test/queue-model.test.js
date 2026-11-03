import test from "node:test";
import assert from "node:assert/strict";
import { checkInState } from "../src/queue.js";

test("Beirut winter/summer time, preceding-day opening and exact boundary instants", () => {
  for (const [date, offset] of [
    ["2026-11-02", "+02:00"],
    ["2026-07-06", "+03:00"],
  ]) {
    const s = { date, startTime: "09:00", endTime: "11:00" };
    for (const [time, expected] of [
      ["08:29:59.999", "not_open"],
      ["08:30:00.000", "open"],
      ["10:59:59.999", "open"],
      ["11:00:00.000", "ended"],
    ]) {
      assert.equal(
        checkInState(s, new Date(`${date}T${time}${offset}`)),
        expected,
      );
    }
  }
  const midnight = { date: "2026-11-03", startTime: "00:15", endTime: "01:00" };
  assert.equal(
    checkInState(midnight, new Date("2026-11-02T23:44:59.999+02:00")),
    "not_open",
  );
  assert.equal(
    checkInState(midnight, new Date("2026-11-02T23:45:00+02:00")),
    "open",
  );
  assert.equal(
    checkInState(midnight, new Date("2026-11-03T01:00:00+02:00")),
    "ended",
  );
});
