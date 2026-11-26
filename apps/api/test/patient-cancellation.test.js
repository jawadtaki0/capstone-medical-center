import test from "node:test";
import assert from "node:assert/strict";

const policy = () => import("../src/patient-cancellation.js");
const now = new Date("2026-12-05T06:00:00Z");
const selection = { date: "2026-12-05", startTime: "10:00" };

for (const [state, clock, eligible] of [
  ["awaiting", now, true],
  ["confirmed", now, true],
  ["confirmed", new Date(+now + 1), false],
  ["confirmed", new Date("2026-12-05T10:00:00Z"), false],
  ["cancelled_by_patient", now, false],
  ["cancelled", now, false],
  ["attended", now, false],
  ["rejected", now, false],
]) {
  test(
    "Beirut cancellation eligibility " + state + " " + clock.toISOString(),
    async () => {
      const { cancellationEligibility } = await policy();
      assert.equal(
        cancellationEligibility({ status: state, selection }, clock, 120)
          .eligible,
        eligible,
      );
    },
  );
}
test("a reason is optional and Other is at most 200 characters", async () => {
  const { cancellationReasons } = await policy();
  assert.deepEqual(cancellationReasons(undefined, undefined), []);
  assert.deepEqual(
    cancellationReasons(["schedule_conflict", "other"], "A plain note"),
    [{ code: "schedule_conflict" }, { code: "other", note: "A plain note" }],
  );
  assert.throws(() => cancellationReasons(["other"], "x".repeat(201)));
  assert.throws(() => cancellationReasons(["unknown"], ""));
  assert.throws(() => cancellationReasons([], "unexpected"));
});
