import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createSecurityFixture } from "./helpers/security-fixture.js";
import { signInSynthetic } from "./helpers/publication-authority.js";

process.env.CEDAR_LAB_REVIEW = "1";
let f;
const people = {};
before(async () => {
  f = await createSecurityFixture();
  await f.reset();
  for (const role of ["Admin", "Lab Admin", "Receptionist", "Clinic Admin"])
    people[role] = await signInSynthetic(f, [role]);
});
after(async () => {
  delete process.env.CEDAR_LAB_REVIEW;
  if (f) {
    await f.reset();
    await f.close();
  }
});

test("only a Lab Admin gets the prepare-draft form", async () => {
  for (const text of [
    "prepare an order for Lina Khoury, test CBC, hemoglobin 13",
    "حضر تقرير للمريضة لينا خوري فحص CBC",
  ])
    for (const role of Object.keys(people)) {
      const result = await f.request("/assistant/message", {
        method: "POST",
        token: people[role].token,
        body: { text, lab: true },
      });
      assert.equal(result.status, 200);
      assert.equal(
        result.body.task?.type,
        role === "Lab Admin" ? "labPrepare" : undefined,
        `${role}: ${text}`,
      );
      if (role === "Lab Admin")
        assert.ok(result.body.task.prefill.firstName, text);
    }
  assert.equal(await f.db.collection("lab_orders").countDocuments(), 0);
});
