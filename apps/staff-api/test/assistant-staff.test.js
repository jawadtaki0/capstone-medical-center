import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createSecurityFixture } from "./helpers/security-fixture.js";
import { signInSynthetic } from "./helpers/publication-authority.js";

let f;
const people = {};
before(async () => {
  f = await createSecurityFixture();
  await f.reset();
  for (const role of ["Admin", "Clinic Admin", "Lab Admin", "Receptionist"])
    people[role] = await signInSynthetic(f, [role]);
});
after(async () => {
  if (f) {
    await f.reset();
    await f.close();
  }
});

test("only Admin gets the staff account form, and asking creates nothing", async () => {
  const accounts = await f.db.collection("accounts").countDocuments();
  for (const text of [
    "create a staff account for Maya Najdi as receptionist",
    "اعمل حساب موظف لمايا نجدي استقبال",
  ])
    for (const role of Object.keys(people)) {
      const result = await f.request("/assistant/message", {
        method: "POST",
        token: people[role].token,
        body: { text },
      });
      assert.equal(result.status, 200);
      assert.equal(
        result.body.task?.type,
        role === "Admin" ? "staffCreate" : undefined,
        `${role}: ${text}`,
      );
      if (role === "Admin") {
        assert.ok(result.body.task.prefill.firstName, text);
        assert.doesNotMatch(JSON.stringify(result.body), /password|setupCode/i);
      }
    }
  assert.equal(await f.db.collection("accounts").countDocuments(), accounts);
});
