import test from "node:test";
import assert from "node:assert/strict";
import { loadHostedPatientAccounts } from "../src/hosted-patient-mail.js";

test("the SES sender delivers a written cancellation notice", async () => {
  const sent = [];
  const { patientAccountDelivery } = loadHostedPatientAccounts(
    {
      CEDAR_PATIENT_ACCOUNTS: "1",
      CEDAR_PATIENT_MAIL_PROVIDER: "ses",
      CEDAR_PATIENT_PHONE_KEY: Buffer.alloc(32, 1).toString("base64url"),
      CEDAR_PATIENT_SES_REGION: "eu-north-1",
      CEDAR_PATIENT_SES_SENDER: "accounts@example.invalid",
      CEDAR_PATIENT_SES_REPLY_TO: "reply@example.invalid",
      CEDAR_PATIENT_SES_CONFIGURATION_SET: "synthetic",
      CEDAR_PATIENT_SES_ACCESS_KEY_ID: "synthetic",
      CEDAR_PATIENT_SES_SECRET_ACCESS_KEY: "synthetic",
    },
    () => ({
      send: async (command) => {
        sent.push(command.input);
        return { MessageId: "synthetic-1" };
      },
    }),
  );
  await patientAccountDelivery({
    to: "patient@example.invalid",
    purpose: "booking-cancellation",
    subject: "Booking cancelled",
    message: "Your synthetic booking was cancelled.",
  });
  const { Subject, Body } = sent[0].Content.Simple;
  assert.equal(Subject.Data, "Booking cancelled");
  assert.equal(Body.Text.Data, "Your synthetic booking was cancelled.");
  assert.equal(Body.Html, undefined);
});
