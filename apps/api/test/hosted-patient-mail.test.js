import assert from "node:assert/strict";
import test from "node:test";
import { loadHostedPatientAccounts } from "../src/hosted-patient-mail.js";

const { patientAccountDelivery: deliver } = loadHostedPatientAccounts({
  CEDAR_PATIENT_ACCOUNTS: "1",
  CEDAR_PATIENT_PHONE_KEY: "a".repeat(43),
  CEDAR_PATIENT_GMAIL_SENDER: "fictional-sender@example.invalid",
  CEDAR_PATIENT_GMAIL_CLIENT_ID: "fictional-client",
  CEDAR_PATIENT_GMAIL_CLIENT_SECRET: "fictional-secret",
  CEDAR_PATIENT_GMAIL_REFRESH_TOKEN: "fictional-refresh",
});
const draft = {
  to: "fictional-recipient@example.invalid",
  purpose: "activate",
  link: "https://example.invalid/account",
  language: "en",
};

const sesEnv = {
  CEDAR_PATIENT_ACCOUNTS: "1",
  CEDAR_PATIENT_PHONE_KEY: "a".repeat(43),
  CEDAR_PATIENT_MAIL_PROVIDER: "ses",
  CEDAR_PATIENT_SES_REGION: "eu-north-1",
  CEDAR_PATIENT_SES_SENDER: "accounts@cmc-cedar.site",
  CEDAR_PATIENT_SES_REPLY_TO: "contact@cmc-cedar.site",
  CEDAR_PATIENT_SES_CONFIGURATION_SET: "cedar-transactional",
  CEDAR_PATIENT_SES_ACCESS_KEY_ID: "fictional-id",
  CEDAR_PATIENT_SES_SECRET_ACCESS_KEY: "fictional-key",
};

test("SES sends one localized account message to the requested address", async () => {
  const sent = [];
  const { patientAccountDelivery } = loadHostedPatientAccounts(
    sesEnv,
    (config) => {
      assert.equal(config.maxAttempts, 1);
      assert.equal(config.region, "eu-north-1");
      return {
        async send(command, options) {
          assert.ok(options.abortSignal instanceof AbortSignal);
          sent.push(command.input);
          return { MessageId: "fictional" };
        },
      };
    },
  );
  for (const purpose of ["activate", "reset", "verify-email"])
    for (const language of ["en", "ar"])
      await patientAccountDelivery({ ...draft, purpose, language });
  assert.equal(sent.length, 6);
  for (const message of sent) {
    assert.deepEqual(message.Destination, { ToAddresses: [draft.to] });
    assert.equal(message.FromEmailAddress, "Cedar Medical Center <accounts@cmc-cedar.site>");
    assert.deepEqual(message.ReplyToAddresses, ["contact@cmc-cedar.site"]);
    assert.equal(message.ConfigurationSetName, "cedar-transactional");
    assert.match(message.Content.Simple.Body.Html.Data, /https:\/\/cmc-cedar\.site\/cedar-email-logo-v1\.png/);
    assert.equal(message.Content.Simple.Subject.Charset, "UTF-8");
    assert.ok(message.Content.Simple.Body.Text.Data.includes(draft.link));
    assert.ok(message.Content.Simple.Body.Html.Data.includes(draft.link));
  }
  assert.notEqual(
    sent[0].Content.Simple.Subject.Data,
    sent[1].Content.Simple.Subject.Data,
  );
});

test("SES fails closed without credentials and hides provider error details", async () => {
  assert.throws(
    () =>
      loadHostedPatientAccounts({
        ...sesEnv,
        CEDAR_PATIENT_SES_SECRET_ACCESS_KEY: "",
      }),
    /configuration required/,
  );
  for (const key of ["CEDAR_PATIENT_SES_REPLY_TO", "CEDAR_PATIENT_SES_CONFIGURATION_SET"]) {
    assert.throws(() => loadHostedPatientAccounts({...sesEnv, [key]: ""}), /configuration required/);
  }
  const { patientAccountDelivery } = loadHostedPatientAccounts(sesEnv, () => ({
    async send() {
      throw Object.assign(new Error("private provider response"), {
        $metadata: { httpStatusCode: 403 },
      });
    },
  }));
  await assert.rejects(patientAccountDelivery(draft), {
    message: "Patient mail delivery unavailable.",
    deliveryStage: "send",
    deliveryReason: "http_403",
  });
});

test("mail delivery separates OAuth refusal, timeout and Gmail refusal", async (t) => {
  const request = t.mock.method(globalThis, "fetch", async () =>
    Response.json(
      { error: "invalid_grant", error_description: "ignored" },
      { status: 400 },
    ),
  );
  await assert.rejects(deliver(draft), {
    deliveryStage: "oauth",
    deliveryReason: "invalid_grant",
  });
  const timeout = t.mock.method(AbortSignal, "timeout", () =>
    AbortSignal.abort(),
  );
  request.mock.mockImplementation(async (_url, { signal }) =>
    signal.throwIfAborted(),
  );
  await assert.rejects(deliver(draft), {
    deliveryStage: "oauth",
    deliveryReason: "timeout",
  });
  timeout.mock.restore();
  request.mock.mockImplementation(async (url) =>
    url.startsWith("https://oauth2.googleapis.com/")
      ? Response.json({ access_token: "fictional-access" })
      : Response.json({ error: { message: "ignored" } }, { status: 403 }),
  );
  await assert.rejects(deliver(draft), {
    deliveryStage: "send",
    deliveryReason: "http_403",
  });
});
