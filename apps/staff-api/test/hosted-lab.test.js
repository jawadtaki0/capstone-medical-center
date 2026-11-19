import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import express from "express";
import { createHostedLab } from "../../api/src/hosted-lab.js";
import { patientAccountRouter } from "../../api/src/patient-accounts.js";
import { websiteRequestRouter } from "../../api/src/website-request-routes.js";
import { signInSynthetic } from "./helpers/publication-authority.js";
import { createSecurityFixture } from "./helpers/security-fixture.js";

const fixture = (options) =>
  createSecurityFixture({
    ...options,
    collectionPrefix: "lab_review_" + randomUUID().replaceAll("-", "") + "_",
  });

test("Lab crosses authenticated stores and cannot restore a withdrawn version", async () => {
  process.env.CEDAR_LAB_REVIEW = "1";
  const hosted = await fixture();
  const service = createHostedLab({ db: hosted.db, key: randomBytes(32) });
  const secret = randomBytes(32).toString("base64url");
  const portal = "https://cedar.example.invalid";
  const endpoint = express()
    .use(
      "/accounts",
      patientAccountRouter({
        db: hosted.db,
        client: hosted.client,
        publicOrigin: portal,
        deliver: () => assert.fail("No live delivery"),
        familyAccess: service,
      }),
    )
    .use(
      websiteRequestRouter({
        service: {},
        credential: secret,
        labIntegration: service.staff,
      }),
    )
    .listen(0, "127.0.0.1");
  await once(endpoint, "listening");
  const url = `http://127.0.0.1:${endpoint.address().port}/integration/lab`;
  const accountRequest = (action, body, session) =>
    fetch(new URL("/accounts/" + action, url), {
      method: "POST",
      headers: {
        Origin: portal,
        "Content-Type": "application/json",
        Cookie: `__Host-cedar-patient=${session}`,
      },
      body: JSON.stringify(body),
    });
  let offline = false;
  let lastRelease;
  const request = (input, credential = secret) =>
    fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credential}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
    });
  let staff;
  try {
    staff = await fixture({
      requestIntegration: {
        transport: {
          lab: async (input) => {
            if (offline) throw Error("Synthetic transport interruption");
            if (input.action === "release") lastRelease = input;
            const response = await request(input);
            assert.equal(
              response.headers.get("cache-control"),
              "private, no-store",
            );
            if (!response.ok) throw Error("Synthetic request failed");
            return response.json();
          },
        },
      },
    });
    await staff.reset();
    const reception = await signInSynthetic(staff, ["Receptionist"]);
    const lab = await signInSynthetic(staff, ["Lab Admin"]);
    const call = (actor, path, body) =>
      staff.request(path, { token: actor.token, method: "POST", body });
    const at = staff.clock();
    const phone = "+12025550142";
    const patient = {
      id: randomUUID(),
      firstName: "Fictional",
      fatherName: "Example",
      lastName: "Release",
      motherFirstName: "Fixture",
      dateOfBirth: "1990-01-01",
      phone,
      gender: "female",
    };
    const { id: _, ...patientFields } = patient;
    const child = {
      ...patientFields,
      firstName: "Child",
      dateOfBirth: "2017-01-01",
    };
    const session = randomBytes(32).toString("base64url");
    const sessionRecord = (token) => ({
      digest: createHash("sha256").update(token).digest("hex"),
      expiresAt: new Date(Date.now() + 600_000),
    });
    const account = {
      _id: randomUUID(),
      emailVerifiedAt: at,
      verifiedWhatsAppPhone: phone,
      profiles: [patient],
      revision: 0,
      sessions: [sessionRecord(session)],
    };
    const otherSession = randomBytes(32).toString("base64url");
    await hosted.db.collection("patient_accounts").insertOne({
      ...account,
      _id: randomUUID(),
      profiles: [],
      sessions: [sessionRecord(otherSession)],
    });
    await hosted.db.collection("patient_accounts").insertOne(account);
    await service.sync(account._id, account.profiles, at);
    const add = {
      creationKey: randomUUID(),
      profiles: [{ relationship: "child", patient: child }],
    };
    const added = await accountRequest("add-profiles", add, session);
    assert.equal(added.status, 200, await added.clone().text());
    const profileId = (await added.json()).account.profiles.find(
      (row) => row.relationship === "child",
    ).id;
    assert.equal(
      (await accountRequest("add-profiles", add, session)).status,
      200,
    );
    assert.equal(
      (
        await request(
          { action: "profiles", criteria: { phone }, after: null },
          "wrong",
        )
      ).status,
      401,
    );
    const search = (criteria) => call(reception, "/patients/search", criteria);
    const first = await search({ phone });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.deepEqual(
      first.body.patients.map((row) => row.id).sort(),
      [patient.id, profileId].sort(),
    );
    assert.deepEqual((await search({ phone })).body, first.body);
    const row = first.body.patients.find((p) => p.id === patient.id);
    assert.equal(
      (await search({ firstName: "Fictional" })).body.patients[0].id,
      row.id,
    );
    assert.equal(
      (await search({ patientNumber: row.patientNumber })).body.patients[0].id,
      row.id,
    );
    const bytes = Buffer.from("%PDF-1.7\nFictional exact bytes");
    const version = {
      id: randomUUID(),
      status: "Finalized",
      finalizedAt: at,
      corrected: false,
      digest: createHash("sha256").update(bytes).digest("hex"),
    };
    const order = {
      _id: randomUUID(),
      revision: 1,
      patientId: patient.id,
      patientNumber: row.patientNumber,
      status: "Ready to release",
      specimens: [],
      tests: [],
      history: [],
      reportVersions: [version],
    };
    await staff.db.collection("lab_orders").insertOne(order);
    await staff.db.collection("lab_reports").insertOne({
      _id: version.id,
      orderId: order._id,
      digest: version.digest,
      pdf: bytes.toString("base64"),
      filename: `LAB-${order._id}-v1.pdf`,
    });
    assert.deepEqual(await service.list(account, patient.id), []);
    const change = (actor, action, revision, extra = {}) =>
      call(actor, "/lab", {
        action,
        revision,
        id: order._id,
        reportId: version.id,
        ...extra,
      });
    const released = await change(reception, "release-report", 1, {
      patientNumber: row.patientNumber,
      orderNumber: "LAB-" + order._id,
    });
    assert.equal(released.status, 200, JSON.stringify(released.body));
    const stored = await hosted.db
      .collection("hosted_lab_reports")
      .findOne({ _id: version.id });
    assert.ok(stored.sealed?.tag);
    assert.equal(stored.pdf, undefined);
    assert.equal((await service.list(account, patient.id))[0].id, version.id);
    assert.deepEqual(
      (await service.download(account, patient.id, version.id)).bytes,
      bytes,
    );
    const download = (profile, cookie = session) =>
      accountRequest(
        "lab-report",
        {
          patientId: profile,
          reportId: version.id,
        },
        cookie,
      );
    const delivered = await download(patient.id);
    assert.equal(delivered.status, 200, await delivered.clone().text());
    assert.equal(delivered.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(Buffer.from(await delivered.arrayBuffer()), bytes);
    assert.equal((await download(profileId)).status, 404);
    assert.equal((await download(patient.id, otherSession)).status, 404);
    assert.equal((await download(patient.id, "")).status, 401);
    offline = true;
    const failed = await change(lab, "withdraw-report", 2, {
      reason: "Fictional correction",
    });
    assert.equal(failed.status, 503);
    assert.equal(
      (await staff.db.collection("lab_orders").findOne({ _id: order._id }))
        .status,
      "Released",
    );
    offline = false;
    assert.equal(
      (
        await change(lab, "withdraw-report", 2, {
          reason: "Fictional correction",
        })
      ).status,
      200,
    );
    assert.equal((await download(patient.id)).status, 404);
    assert.deepEqual(await service.staff(lastRelease), { withdrawn: true });
    assert.deepEqual(await service.list(account, patient.id), []);
  } finally {
    await staff?.close();
    endpoint.closeAllConnections();
    await new Promise((resolve) => endpoint.close(resolve));
    await hosted.close();
  }
});
