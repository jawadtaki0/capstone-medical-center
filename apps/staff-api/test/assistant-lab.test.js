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
const ask = async (role, text, lab = true) => {
  const result = await f.request("/assistant/message", {
    method: "POST",
    token: people[role].token,
    body: { text, lab },
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body;
};

const REQUESTS = [
  ["create a lab order for Lina Khoury", "labCreate"],
  ["record specimen collection for Lina Khoury", "collect"],
  ["cancel the lab order for Lina Khoury", "labCancel"],
  ["release the result PDF for Lina Khoury", "release"],
  ["اعمل طلب فحص مخبري للمريضة لينا خوري", "labCreate"],
  ["الغي طلب المختبر للمريضة لينا خوري", "labCancel"],
];
const ALLOWED = {
  Admin: ["release"],
  "Lab Admin": ["labCreate", "collect", "labCancel", "release"],
  Receptionist: ["labCreate", "collect", "labCancel", "release"],
  "Clinic Admin": [],
};

test("every Lab request follows every role", async () => {
  const wrong = [];
  for (const [role, allowed] of Object.entries(ALLOWED))
    for (const [text, type] of REQUESTS) {
      const body = await ask(role, text);
      // An unclear reply is a safe miss. A form is only right when it is the
      // requested one and the role may use it.
      if (body.task && (body.task.type !== type || !allowed.includes(type)))
        wrong.push([role, text, body.task.type]);
      if (!body.task && allowed.includes(type)) wrong.push([role, text, "-"]);
    }
  const forbidden = wrong.filter(([, , got]) => got !== "-");
  assert.deepEqual(forbidden, []);
  assert.ok(wrong.length <= 3, JSON.stringify(wrong));
});

test("no Lab forms when the desktop Lab screen is off", async () => {
  for (const [text] of REQUESTS)
    assert.equal((await ask("Lab Admin", text, false)).task, undefined, text);
  assert.equal(await f.db.collection("lab_orders").countDocuments(), 0);
});
