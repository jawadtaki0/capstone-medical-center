import test from "node:test";
import assert from "node:assert/strict";
import {
  namedTests,
  typedValues,
  createPrepareRun,
} from "../src/lib/assistantPrepare.js";

const catalogue = [
  {
    _id: "cbc",
    name: "CBC (complete blood count)",
    fields: [{ name: "Hemoglobin" }, { name: "WBC" }, { name: "Platelets" }],
  },
  { _id: "glu", name: "Fasting glucose", fields: [{ name: "Glucose" }] },
  { _id: "tsh", name: "TSH", fields: [{ name: "TSH" }] },
];

test("only tests that were named are pre-ticked", () => {
  assert.deepEqual(namedTests("prepare Sami, test CBC", catalogue), ["cbc"]);
  assert.deepEqual(namedTests("fasting glucose and tsh please", catalogue), [
    "glu",
    "tsh",
  ]);
  assert.deepEqual(namedTests("prepare an order", catalogue), []);
});

test("typed values land only in the field they name", () => {
  const text = "CBC hemoglobin 13.5, WBC: 6,2 platelets=250 glucose is 90";
  assert.deepEqual(typedValues(text, catalogue[0].fields), [
    "13.5",
    "6,2",
    "250",
  ]);
  assert.deepEqual(typedValues(text, catalogue[1].fields), ["90"]);
  assert.deepEqual(typedValues("test CBC", catalogue[0].fields), ["", "", ""]);
});

function fakeLab(failOn) {
  const calls = [];
  let order,
    failed = false;
  const api = {
    lab: async (input) => {
      calls.push(input.action);
      if (input.action === failOn && !failed) {
        failed = true;
        throw new Error("Synthetic failure");
      }
      if (input.action === "create")
        order = {
          _id: "order-1",
          revision: 1,
          status: "Registered",
          tests: [{ _id: "cbc" }],
          specimens: [{ id: "s1", testIds: ["cbc"], checked: false }],
          history: [],
        };
      else {
        assert.equal(input.revision, order.revision);
        order = { ...order, revision: order.revision + 1 };
        if (input.action === "check") order.specimens[0].checked = true;
        if (input.action === "collect") order.status = "Sample collected";
        if (input.action === "results")
          order.tests = [{ _id: "cbc", results: input.results }];
      }
      if (input.action === "preview-report") return { order, fileSaved: true };
      return order;
    },
  };
  return { api, calls };
}
const draft = (api) =>
  createPrepareRun({
    api,
    patient: { id: "p1", revision: 1 },
    testIds: ["cbc"],
    values: { cbc: ["13.5"] },
  });

test("one confirmation creates, records and drafts, never releases", async () => {
  const { api, calls } = fakeLab();
  const run = draft(api);
  assert.equal(calls.length, 0);
  const result = await run.prepare();
  assert.equal(result.fileSaved, true);
  assert.deepEqual(calls, [
    "create",
    "check",
    "collect",
    "results",
    "preview-report",
  ]);
});

test("a retry continues the same order instead of making another", async () => {
  const { api, calls } = fakeLab("results");
  const run = draft(api);
  await assert.rejects(run.prepare(), (error) => {
    assert.equal(error.order._id, "order-1");
    return true;
  });
  await run.prepare();
  assert.equal(calls.filter((a) => a === "create").length, 1);
  assert.equal(calls.filter((a) => a === "collect").length, 1);
});
