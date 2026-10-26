import test from "node:test";
import assert from "node:assert/strict";
import { BSON } from "mongodb";
import { planPublicBaseline } from "../src/public-baseline-import.js";

import { syntheticBaselineSnapshot } from "./helpers/public-baseline.js";
test("baseline plan preserves IDs, restrictions, gender and undated lineage with unset legacy limits", () => {
  const snapshot = syntheticBaselineSnapshot();
  const before = Buffer.concat(
    snapshot.collections.weekly_schedules.raw,
  ).toString("hex");
  const plan = planPublicBaseline(snapshot);
  assert.equal(
    plan.collections.doctor_profile_drafts[0].id,
    "doctor:synthetic-import",
  );
  assert.equal(plan.collections.doctor_profile_drafts[0].gender, "female");
  const session = plan.collections.operational_session_drafts.find(
    (s) => s.professionalId,
  );
  assert.equal(session.id, "synthetic-session");
  assert.equal(session.capacity, null);
  assert.equal(plan.version, 2);
  assert.equal(plan.capacityRule, "manual-nullable-v1");
  assert.equal(session.appointmentRequired, true);
  assert.deepEqual(plan.collections.operational_grants, undefined);
  assert.equal(plan.lineage.weeklyScheduleId, "weekly:synthetic-import");
  assert.equal(plan.effectiveFrom, null);
  assert.equal(
    Buffer.concat(snapshot.collections.weekly_schedules.raw).toString("hex"),
    before,
  );
  assert.equal(plan.digest, planPublicBaseline(snapshot).digest);
});
test("mapping refuses missing gender, invalid hours, extra profile fields and ambiguous weekly versions", () => {
  for (const mutate of [
    (data) => {
      delete data.doctor_profiles[0].gender;
    },
    (data) => {
      data.doctor_profiles[0].email = "private@example.invalid";
    },
    (data) => {
      data.weekly_schedules[0].days[1].doctorSessions[0].endTime = "08:50";
    },
    (data) => {
      data.weekly_schedules.push({
        ...data.weekly_schedules[0],
        _id: "weekly:other",
      });
    },
  ]) {
    const snapshot = syntheticBaselineSnapshot();
    const data = Object.fromEntries(
      Object.entries(snapshot.collections).map(([name, entry]) => [
        name,
        entry.raw.map((raw) => BSON.deserialize(raw)),
      ]),
    );
    mutate(data);
    for (const [name, docs] of Object.entries(data))
      snapshot.collections[name].raw = docs.map((doc) => BSON.serialize(doc));
    assert.throws(() => planPublicBaseline(snapshot));
  }
});

test("non-divisible hours are valid and explicit legacy manual limits or null are preserved, not recalculated", () => {
  for (const capacity of [undefined, null, 3, 101]) {
    const snapshot = syntheticBaselineSnapshot();
    const weekly = BSON.deserialize(
      snapshot.collections.weekly_schedules.raw[0],
    );
    const session = weekly.days[1].doctorSessions[0];
    session.endTime = "10:07";
    if (capacity !== undefined) session.capacity = capacity;
    snapshot.collections.weekly_schedules.raw = [BSON.serialize(weekly)];
    const plan = planPublicBaseline(snapshot);
    assert.equal(
      plan.collections.operational_session_drafts.find((s) => s.professionalId)
        .capacity,
      capacity ?? null,
    );
  }
});
