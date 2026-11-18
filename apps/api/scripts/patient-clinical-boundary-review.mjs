import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { beirutEnd } from "../../../shared/website-request-contract.mjs";
import { createSecurityFixture } from "../../staff-api/test/helpers/security-fixture.js";
import { seedPublicationAuthority } from "../../staff-api/test/helpers/publication-authority.js";
import { createRequestTransport } from "../../staff-api/src/request-integration.js";

export async function verifyPatientClinicalBoundary({
  origin,
  credential,
  requestKey,
  pending,
  callAccount,
  selection,
  accounts,
}) {
  const integration = {
    mode: "test",
    target: origin + "/api/requests/integration",
    credential,
    key: requestKey,
    publicBase: origin,
    contact: "Cedar TEST",
  };
  integration.transport = createRequestTransport(integration);
  const staff = await createSecurityFixture({
    collectionPrefix: `patient_phone_review_${randomUUID().replaceAll("-", "")}_`,
    requestIntegration: integration,
  });
  try {
    await staff.reset();
    staff.advance(beirutEnd(selection.date, "08:45") - staff.clock());
    const authority = await seedPublicationAuthority(staff);
    authority.ok(await authority.publish(null));
    const post = (path, body) =>
      staff.request(path, {
        method: "POST",
        body,
        token: authority.admin.token,
      });
    const good = async (path, body) => authority.ok(await post(path, body));
    const phone = (action, id) =>
      good("/website-requests/phoneVerification", {
        action,
        ...(id ? { id } : {}),
      });
    const options = { cookie: pending.cookie };
    const initial = await accounts.findOne({ email: pending.email });
    const adult = (
      await callAccount(
        "add-profiles",
        {
          profiles: [
            {
              relationship: "self",
              patient: {
                firstName: "Rana",
                fatherName: "Sami",
                lastName: "Demo",
                motherFirstName: "Hala Sample",
                dateOfBirth: "1990-01-02",
                gender: "female",
              },
            },
          ],
        },
        options,
      )
    ).result.account.profiles.find(
      (profile) => profile.relationship === "self",
    );
    const assertBoundary = async () => {
      for (const path of [
        "/api/patient-account/records",
        "/api/patients/read",
        "/api/lab/results",
        "/api/audiometry/results",
      ]) {
        const response = await fetch(origin + path, {
          method: "POST",
          headers: {
            Origin: origin,
            "Content-Type": "application/json",
            Cookie: pending.cookie,
          },
          body: JSON.stringify({ profileId: adult.id }),
        });
        assert.equal(response.status, 404, path);
      }
      const row = await accounts.findOne({ _id: initial._id });
      assert.deepEqual(
        Object.keys(row)
          .filter((key) => !Object.hasOwn(initial, key))
          .sort(),
        ["phoneCheck", "verifiedPersonalPhone", "verifiedWhatsAppPhone"],
      );
      assert.ok(
        row.profiles.every((profile) => !Object.hasOwn(profile, "patientId")),
      );
    };
    const input = {
      profileId: adult.id,
      selection,
      submissionKey: randomBytes(32).toString("base64url"),
      language: "en",
      honeypot: "",
    };
    await callAccount("book", input, { ...options, status: 403 });
    await callAccount(
      "phone-request",
      { personal: true, language: "en" },
      options,
    );
    const { rows } = await phone("list");
    const request = rows.find((row) => row.account === "review.pending");
    const { message } = await phone("prepare", request.id);
    await phone("opened", request.id);
    await phone("sent", request.id);
    await callAccount(
      "phone-verify",
      { code: message.match(/\b\d{6}\b/)[0] },
      options,
    );
    await assertBoundary();
    console.log("PASS verified personal phone leaves clinical records private");

    const { result: receipt } = await callAccount("book", input, options);
    await assertBoundary();
    await good("/website-requests/refresh", {});
    const detail = await good("/website-requests/detail", {
      id: receipt.requestId,
    });
    const { request: linked } = await good("/website-requests/createPatient", {
      id: receipt.requestId,
      revision: detail.request.revision,
      reviewDigest: detail.matches.reviewDigest,
      duplicateOverride: {
        acknowledged: true,
        reason: "Distinct fictional clinical boundary review patient",
      },
    });
    const review = await good("/website-requests/review", {
      id: receipt.requestId,
    });
    const { request: confirmed } = await good("/website-requests/confirm", {
      id: receipt.requestId,
      revision: linked.revision,
      booking: {
        patientId: review.patient.id,
        patientRevision: review.patient.revision,
        date: selection.date,
        scopeId: linked.scopeId,
        sourceSessionId: selection.sourceSessionId,
        sessionVersion: review.session.version,
        idempotencyKey: randomUUID(),
      },
    });
    await good("/website-requests/refresh", {});
    await assertBoundary();
    const { sessions } = await good("/queue/sessions", {
      date: selection.date,
    });
    const session = sessions.find(
      (item) => item.sourceSessionId === selection.sourceSessionId,
    );
    await good("/queue/checkIn", {
      date: selection.date,
      scopeId: session.scopeId,
      sourceSessionId: session.sourceSessionId,
      sessionVersion: session.scheduleSignature,
      bookingId: confirmed.bookingId,
      expectedRevision: 0,
      idempotencyKey: randomUUID(),
    });
    const booking = await staff.db
      .collection("bookings")
      .findOne({ _id: confirmed.bookingId });
    assert.ok(booking?.queue);
    const privatePatient = await good("/patients/read", {
      patientId: booking.patientId,
    });
    assert.equal(privatePatient.patient.id, booking.patientId);
    const denied = await staff.request("/patients/read", {
      method: "POST",
      headers: { Cookie: pending.cookie },
      body: { patientId: booking.patientId },
    });
    assert.equal(denied.status, 401);
    await assertBoundary();
    const { result: history } = await callAccount(
      "profile-requests",
      { profileId: adult.id },
      options,
    );
    assert.deepEqual(
      history.requests.map(({ reference, status }) => [reference, status]),
      [[receipt.reference, "confirmed"]],
    );
    assert.ok(!JSON.stringify(history).includes(booking.patientId));
    const child = pending.result.account.profiles[0];
    const { result: childHistory } = await callAccount(
      "profile-requests",
      { profileId: child.id },
      options,
    );
    assert.deepEqual(childHistory.requests, []);
    console.log(
      "PASS real request, reception confirmation and check-in preserve booking ownership without exposing the private patient",
    );
  } finally {
    await staff.close();
  }
}
