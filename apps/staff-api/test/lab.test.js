import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createSecurityFixture } from "./helpers/security-fixture.js";
import { signInSynthetic } from "./helpers/publication-authority.js";

test("standalone Lab preserves approved snapshots and enforces specimen transitions", async () => {
  process.env.CEDAR_LAB_REVIEW = "1";
  const f = await createSecurityFixture({
    collectionPrefix: "lab_review_" + randomUUID().replaceAll("-", "") + "_",
  });
  try {
    await f.reset();
    const reception = await signInSynthetic(f, ["Receptionist"]);
    const lab = await signInSynthetic(f, ["Lab Admin"]);
    const admin = await signInSynthetic(f, ["Admin"]);
    const clinic = await signInSynthetic(f, ["Clinic Admin"]);
    const post = (actor, path, body) =>
      f.request(path, { method: "POST", token: actor.token, body });
    const call = (actor, body) => post(actor, "/lab", body);
    const perform = async (actor, body) => {
      const result = await call(actor, body);
      assert.equal(result.status, 200, JSON.stringify(result.body));
      return result.body;
    };
    assert.equal((await call(clinic, { action: "list" })).status, 403);
    const record = {
      firstName: "Synthetic",
      fatherName: "Father",
      lastName: "Labexample",
      motherFirstName: "Mother",
      dateOfBirth: "2000-02-29",
      phone: "+12025550142",
      gender: "female",
    };
    const check = await post(reception, "/patients/check", { record });
    assert.equal(check.status, 200);
    const created = await post(reception, "/patients/create", {
      record,
      reviewDigest: check.body.reviewDigest,
    });
    assert.equal(created.status, 200);
    const { patient } = created.body;
    const found = await post(reception, "/patients/search", {
      patientNumber: patient.patientNumber,
    });
    assert.equal(found.body.patients[0].id, patient.id);
    const fields = [
      { name: "Fictional field", unit: "demo", reference: "Synthetic only" },
    ];
    const save = (name, group) =>
      perform(admin, {
        action: "save",
        name,
        specimen: "Blood",
        group,
        fields,
      });
    const first = await save("Fictional A", "Shared tube");
    const second = await save("Fictional B", "Shared tube");
    const third = await save("Fictional C", "");
    const action = (action, row, extra = {}) => ({
      action,
      id: row._id,
      revision: row.revision,
      ...extra,
    });
    const approve = (row) =>
      action("approve", row, { reason: "Synthetic approval fixture" });
    assert.equal(
      (await perform(admin, approve(first))).approval.actor,
      admin.id,
    );
    const intake = {
      action: "create",
      patientId: patient.id,
      patientRevision: patient.revision,
      testIds: [first._id, second._id, third._id],
    };
    assert.equal((await call(reception, intake)).status, 400);
    for (const row of [second, third]) await perform(lab, approve(row));
    const adminOrder = await perform(admin, intake);
    assert.equal(adminOrder.patientId, patient.id);
    assert.equal((await call(clinic, intake)).status, 403);
    let order = await perform(reception, intake);
    assert.equal(order.patientId, patient.id);
    assert.equal(order.specimens.length, 2);
    assert.equal(order.specimens.find((row) => row.group).testIds.length, 2);
    assert.equal((await call(reception, action("collect", order))).status, 400);
    const cancel = (row) =>
      action("cancel", row, { reason: "Synthetic whole order cancellation" });
    const untouched = await perform(reception, intake);
    assert.equal(
      (await perform(reception, cancel(untouched))).status,
      "Cancelled",
    );
    const partial = await perform(
      reception,
      action("check", order, { target: order.specimens[0].id, checked: true }),
    );
    order = await perform(
      reception,
      action("check", partial, {
        target: partial.specimens[0].id,
        checked: false,
      }),
    );
    assert.equal((await call(reception, cancel(order))).status, 403);
    for (const row of order.specimens)
      order = await perform(
        reception,
        action("check", order, { target: row.id, checked: true }),
      );
    order = await perform(reception, action("collect", order));
    assert.equal(order.status, "Sample collected");
    assert.equal(
      (await call(reception, action("cancel", order, { reason: "Fixture" })))
        .status,
      403,
    );
    const target = order.specimens[0].id;
    const recollect = action("recollect", order, {
      target,
      reason: "Synthetic recollection",
    });
    assert.equal((await call(reception, recollect)).status, 403);
    order = await perform(lab, recollect);
    assert.equal(order.status, "Registered");
    assert.equal((await call(reception, cancel(order))).status, 403);
    assert.equal(
      order.specimens.find((row) => row.id === target).checked,
      false,
    );
    assert.equal(
      order.specimens.find((row) => row.id !== target).checked,
      true,
    );
    assert.equal((await call(lab, recollect)).status, 409);
    order = await perform(
      lab,
      action("cancel-test", order, {
        target: first._id,
        reason: "Synthetic cancellation",
      }),
    );
    const listed = await perform(lab, { action: "list" });
    const catalogueFirst = listed.catalogue.find(
      (test) => test._id === first._id,
    );
    await perform(admin, action("retire", catalogueFirst));
    assert.equal((await call(reception, intake)).status, 400);
    order = await perform(
      lab,
      action("cancel", order, { reason: "Synthetic whole order cancellation" }),
    );
    assert.equal(order.status, "Cancelled");
    assert.equal(
      order.tests.find((test) => test._id === first._id).active,
      true,
    );
    assert.ok(
      order.history.some(
        (event) => event.action === "recollect" && event.reason,
      ),
    );
    assert.equal(
      (await perform(reception, { action: "list" })).orders.find(
        (row) => row._id === order._id,
      ).status,
      "Cancelled",
    );
  } finally {
    await f.reset();
    await f.close();
    delete process.env.CEDAR_LAB_REVIEW;
  }
});
