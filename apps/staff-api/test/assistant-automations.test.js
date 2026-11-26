import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createSecurityFixture } from "./helpers/security-fixture.js";
import {
  seedPublicationAuthority,
  signInSynthetic,
} from "./helpers/publication-authority.js";

process.env.CEDAR_LAB_REVIEW = "1";
let f;
const people = {};
before(async () => {
  f = await createSecurityFixture();
  await f.reset();
  const authority = await seedPublicationAuthority(f);
  assert.equal((await authority.publish(null)).status, 200);
  people.Admin = authority.admin;
  for (const role of ["Clinic Admin", "Lab Admin", "Receptionist"]) {
    people[role] = await signInSynthetic(f, [role]);
    await f.db.collection("operational_grants").insertOne({
      _id: people[role].id,
      id: people[role].id,
      scopeIds: ["clinic:synthetic"],
      revision: 1,
    });
  }
});
after(async () => {
  delete process.env.CEDAR_LAB_REVIEW;
  if (f) {
    await f.reset();
    await f.close();
  }
});

const ask = async (role, text) => {
  const result = await f.request("/assistant/message", {
    method: "POST",
    token: people[role].token,
    body: { text, lab: true },
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body;
};

test("what needs attention comes from the Today counts", async () => {
  for (const [role, text] of [
    ["Admin", "what needs my attention today?"],
    ["Receptionist", "شو المطلوب مني اليوم؟"],
    ["Lab Admin", "what do I need to do today"],
  ]) {
    const body = await ask(role, text);
    assert.equal(body.kind, "attention", `${role}: ${text}`);
    const summary = (
      await f.request("/summary/read", {
        method: "POST",
        token: people[role].token,
        body: {},
      })
    ).body;
    for (const item of body.items)
      assert.equal(item.count, summary.counts[item.id], item.id);
    if (role === "Lab Admin") assert.deepEqual(body.items, []);
  }
});

const CASES = [
  [
    "check in Lina Khoury",
    "checkin",
    ["Admin", "Clinic Admin", "Receptionist"],
  ],
  ["add a walk-in patient to the queue", "walkin", ["Admin", "Receptionist"]],
  [
    "publish the schedule changes to the website",
    "publish",
    ["Admin", "Clinic Admin"],
  ],
  ["reject the website request", "request", ["Admin", "Receptionist"]],
  [
    "update Lina Khoury's phone number",
    "patientUpdate",
    ["Admin", "Clinic Admin", "Lab Admin", "Receptionist"],
  ],
  ["recollect the sample for Lina Khoury", "recollect", ["Lab Admin"]],
  ["reopen the report for Lina Khoury", "reopen", ["Lab Admin"]],
  ["withdraw the report for Lina Khoury", "withdraw", ["Admin", "Lab Admin"]],
  ["add a new test to the Lab catalogue", "catalogue", ["Lab Admin"]],
  ["change the doctor's weekly hours", "schedule", ["Admin", "Clinic Admin"]],
];

test("each automation is offered only to roles that may do it", async () => {
  const wrong = [];
  for (const [text, type, allowed] of CASES)
    for (const role of Object.keys(people)) {
      const body = await ask(role, text);
      const got = body.task?.type;
      // Offering a form the role cannot use is never acceptable.
      if (got && !allowed.includes(role))
        assert.fail(`${role} was offered ${got} for "${text}"`);
      if (allowed.includes(role) && got !== type)
        wrong.push([role, text, got ?? body.kind]);
    }
  assert.deepEqual(wrong, []);
});

test("plain update requests open the right record form", async () => {
  const body = await ask("Receptionist", "update Lina Khoury phone number");
  assert.equal(body.task?.type, "patientUpdate");
  assert.equal(body.task.prefill.firstName, "Lina");
  assert.equal(body.task.prefill.lastName, "Khoury");
  assert.equal(
    (await ask("Receptionist", "change my phone number")).task,
    undefined,
  );
});

test("asking about an automation changes nothing", async () => {
  const names = [
    "patients",
    "bookings",
    "queue_changes",
    "operational_publications",
    "lab_catalogue",
    "lab_orders",
    "website_request_inbox",
  ];
  const count = () =>
    Promise.all(names.map((n) => f.db.collection(n).countDocuments()));
  const before = await count();
  for (const [text, , allowed] of CASES) await ask(allowed[0], text);
  assert.deepEqual(await count(), before);
});
