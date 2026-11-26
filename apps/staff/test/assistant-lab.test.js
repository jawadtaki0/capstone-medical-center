import test from "node:test";
import assert from "node:assert/strict";
import {
  eligibleOrders,
  releasableReport,
  collectOrder,
} from "../src/lib/assistantLab.js";

const specimen = (id, testIds, checked = false) => ({
  id,
  testIds,
  checked,
  kind: "Blood",
});
const order = (id, status, extra = {}) => ({
  _id: id,
  status,
  revision: 1,
  patientName: "Lina Khoury",
  patientNumber: "P-00000001",
  tests: [{ _id: "t1" }, { _id: "t2" }],
  specimens: [specimen("s1", ["t1"]), specimen("s2", ["t2"])],
  history: [],
  reportVersions: [],
  ...extra,
});
const orders = [
  order("registered", "Registered"),
  order("started", "Registered", {
    specimens: [specimen("s1", ["t1"], true)],
  }),
  order("collected", "Sample collected"),
  order("ready", "Ready to release", {
    reportVersions: [
      { id: "old", version: 1, status: "Reopened" },
      { id: "new", version: 2, status: "Finalized" },
    ],
  }),
  order("released", "Released"),
  order("cancelled", "Cancelled"),
];
const ids = (task, roles) =>
  eligibleOrders(orders, task, roles).map((o) => o._id);

test("each Lab task lists only eligible orders for the role", () => {
  assert.deepEqual(ids("collect", ["Receptionist"]), ["registered", "started"]);
  assert.deepEqual(ids("labCancel", ["Receptionist"]), ["registered"]);
  assert.deepEqual(ids("labCancel", ["Lab Admin"]), [
    "registered",
    "started",
    "collected",
  ]);
  assert.deepEqual(ids("labCancel", ["Admin"]), []);
  assert.deepEqual(ids("release", ["Admin"]), ["ready"]);
});

test("release names the current finalized version only", () => {
  assert.equal(releasableReport(orders[3]).id, "new");
  assert.equal(releasableReport(orders[4]), null);
});

test("collection checks remaining specimens, then collects once", async () => {
  const calls = [];
  let revision = 1;
  const api = {
    lab: async (input) => {
      calls.push([input.action, input.target, input.revision]);
      assert.equal(input.revision, revision);
      return { ...orders[0], revision: ++revision };
    },
  };
  const row = order("registered", "Registered", {
    specimens: [specimen("s1", ["t1"], true), specimen("s2", ["t2"])],
  });
  assert.equal(calls.length, 0);
  await collectOrder(api, row);
  assert.deepEqual(calls, [
    ["check", "s2", 1],
    ["collect", undefined, 2],
  ]);
});

test("a changed order stops collection", async () => {
  const calls = [];
  const api = {
    lab: async (input) => {
      calls.push(input.action);
      throw new Error("Reload the Lab order.");
    },
  };
  await assert.rejects(collectOrder(api, orders[0]));
  assert.deepEqual(calls, ["check"]);
});
