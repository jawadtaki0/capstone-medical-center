// Sends each Lab card's requests as every role, against the real Lab rules.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createSecurityFixture } from "./helpers/security-fixture.js";
import { signInSynthetic } from "./helpers/publication-authority.js";
import {
  collectOrder,
  releaseRequest,
} from "../../staff/src/lib/assistantLab.js";

const ROLES = ["Admin", "Lab Admin", "Receptionist", "Clinic Admin"];

test("Lab actions follow the server rules for every role", async () => {
  process.env.CEDAR_LAB_REVIEW = "1";
  const f = await createSecurityFixture({
    collectionPrefix: "lab_review_" + randomUUID().replaceAll("-", "") + "_",
  });
  try {
    await f.reset();
    const people = {};
    for (const role of ROLES) people[role] = await signInSynthetic(f, [role]);
    const post = (role, path, body) =>
      f.request(path, { method: "POST", token: people[role].token, body });
    const good = (r) => {
      assert.equal(r.status, 200, JSON.stringify(r.body));
      return r.body;
    };
    const lab = (role, body) => post(role, "/lab", body);
    const api = (role) => ({
      lab: async (body) => {
        const result = await lab(role, body);
        if (result.status !== 200)
          throw Object.assign(new Error(result.body.error.message), {
            status: result.status,
          });
        return result.body;
      },
    });
    const step = async (action, order, extra = {}) =>
      good(
        await lab("Lab Admin", {
          action,
          id: order._id,
          revision: order.revision,
          ...extra,
        }),
      );

    const record = {
      firstName: "Synthetic",
      fatherName: "Father",
      lastName: "Labroles",
      motherFirstName: "Mother",
      dateOfBirth: "2000-02-29",
      phone: "+12025550142",
      gender: "female",
    };
    const check = good(
      await post("Receptionist", "/patients/check", { record }),
    );
    const patient = good(
      await post("Receptionist", "/patients/create", {
        record,
        reviewDigest: check.reviewDigest,
      }),
    ).patient;
    const saved = good(
      await lab("Lab Admin", {
        action: "save",
        name: "Fictional test",
        specimen: "Blood",
        group: "",
        fields: [{ name: "Value", unit: "demo", reference: "Synthetic" }],
      }),
    );
    const approved = await step("approve", saved, { reason: "Synthetic" });
    const intake = {
      action: "create",
      patientId: patient.id,
      patientRevision: patient.revision,
      testIds: [approved._id],
    };
    const newOrder = async () => good(await lab("Lab Admin", intake));
    const readyOrder = async () => {
      let order = await newOrder();
      order = await collectOrder(api("Lab Admin"), order);
      order = await step("results", order, {
        target: approved._id,
        results: ["1"],
      });
      const preview = await step("preview-report", order);
      return step("finalize-report", preview.order, {
        reportId: preview.order.reportPreview.id,
      });
    };

    const results = {};
    for (const role of ROLES) {
      const created = await lab(role, intake);
      const collect = await collectOrder(api(role), await newOrder()).then(
        () => 200,
        (error) => error.status,
      );
      const open = await newOrder();
      const cancel = await lab(role, {
        action: "cancel",
        id: open._id,
        revision: open.revision,
        reason: "Synthetic",
      });
      const ready = await readyOrder();
      const typed = {
        patientNumber: ready.patientNumber,
        orderNumber: "LAB-" + ready._id,
      };
      const wrong = await lab(
        role,
        releaseRequest(ready, { ...typed, patientNumber: "P-99999999" }),
      );
      const release = await lab(role, releaseRequest(ready, typed));
      results[role] = {
        create: created.status,
        collect,
        cancel: cancel.status,
        wrongNumberRefused: wrong.status !== 200,
        release: release.status,
      };
    }
    const allowed = (create, collect, cancel, release) => ({
      create,
      collect,
      cancel,
      wrongNumberRefused: true,
      release,
    });
    assert.deepEqual(results, {
      Admin: allowed(403, 403, 403, 200),
      "Lab Admin": allowed(200, 200, 200, 200),
      Receptionist: allowed(200, 200, 200, 200),
      "Clinic Admin": allowed(403, 403, 403, 403),
    });
  } finally {
    await f.reset();
    await f.close();
    delete process.env.CEDAR_LAB_REVIEW;
  }
});
