import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  createGmailDelivery,
  enableStaffSelfService,
  loadDeliveryConfig,
  normalizeEmail,
  saveDeliveryConfig,
  validateDeliveryConfig,
} from "../src/contact-delivery.js";
import { dpapi } from "../src/local-security.js";

const config = (overrides) => ({
  version: 2,
  deliveryScope: "staff_self_service",
  provider: "gmail",
  sender: "synthetic.sender@gmail.com",
  appPassword: "invalid-synthetic-shape",
  enabled: false,
  allowance: 0,
  ...overrides,
});
// Not a usable credential; tests never construct a real SMTP transport.
const enabledConfig = () =>
  config({
    appPassword: "SyntheticOnly123",
    enabled: true,
    allowance: 2,
    approvalId: randomUUID(),
  });

test("delivery configuration requires app-password shape and allowance but no recipient list", () => {
  assert.equal(
    normalizeEmail(" SYNTHETIC@Example.Invalid "),
    "synthetic@example.invalid",
  );
  assert.throws(() =>
    normalizeEmail("a@example.invalid\r\nBcc: other@example.invalid"),
  );
  const disabled = config({ appPassword: "SyntheticOnly123" });
  assert.equal(validateDeliveryConfig(disabled).enabled, false);
  assert.throws(() => validateDeliveryConfig(config()));
  assert.throws(() => validateDeliveryConfig({ ...disabled, enabled: true }));
  assert.equal(
    Object.hasOwn(validateDeliveryConfig(enabledConfig()), "recipients"),
    false,
  );
  assert.throws(() =>
    validateDeliveryConfig({ ...enabledConfig(), deliveryScope: "other" }),
  );
  assert.throws(() =>
    validateDeliveryConfig({ ...enabledConfig(), allowance: 21 }),
  );
  assert.throws(() =>
    validateDeliveryConfig({
      ...enabledConfig(),
      sender: "synthetic@example.invalid",
    }),
  );
});

test("missing, disabled and legacy restricted settings have distinct safe errors before any transport", async () => {
  let transports = 0;
  const transport = () => {
    transports++;
    throw new Error("Never construct real transport in TEST");
  };
  for (const [load, code] of [
    [
      async () => {
        throw new Error("ENOENT synthetic");
      },
      "contact_delivery_not_configured",
    ],
    [
      async () => config({ appPassword: "SyntheticOnly123" }),
      "contact_delivery_disabled",
    ],
    [
      async () => ({
        ...enabledConfig(),
        version: 1,
        recipients: ["other@example.invalid"],
      }),
      "contact_delivery_activation_required",
    ],
  ]) {
    const provider = createGmailDelivery({ load, transport });
    await assert.rejects(
      provider.send({
        destination: "unapproved@example.invalid",
        code: "12345678",
      }),
      { code },
    );
  }
  assert.equal(transports, 0);
});

test("one-time self-service activation preserves the legacy approval budget identity, allowance and credentials without mutating input", () => {
  const legacy = {
    ...enabledConfig(),
    version: 1,
    recipients: ["old-selected@example.invalid"],
  };
  const before = structuredClone(legacy);
  const converted = enableStaffSelfService(legacy);
  assert.equal(converted.version, 2);
  assert.equal(converted.deliveryScope, "staff_self_service");
  assert.equal(converted.approvalId, legacy.approvalId);
  assert.equal(converted.allowance, legacy.allowance);
  assert.equal(converted.sender, legacy.sender);
  assert.equal(converted.appPassword, legacy.appPassword);
  assert.equal(Object.hasOwn(converted, "recipients"), false);
  assert.deepEqual(legacy, before);
  assert.deepEqual(enableStaffSelfService(converted), converted);
  assert.throws(
    () => enableStaffSelfService(config({ appPassword: "SyntheticOnly123" })),
    /existing approved allowance/i,
  );
});

test("transport construction and cleanup failures cannot expose raw provider details", async () => {
  const value = enabledConfig();
  const provider = createGmailDelivery({
    load: async () => value,
    transport() {
      throw new Error("synthetic-private-provider-detail");
    },
  });
  await assert.rejects(
    provider.send({
      destination: "unlisted@example.invalid",
      code: "00123456",
    }),
    (error) => {
      assert.equal(error.code, "contact_delivery_failed");
      assert.doesNotMatch(error.message, /synthetic-private|00123456/);
      return true;
    },
  );
});

test("Gmail transport uses fixed TLS SMTP without logs, files, URLs or private profile fields", async () => {
  const value = enabledConfig();
  let options,
    message,
    closed = 0;
  const provider = createGmailDelivery({
    load: async () => value,
    transport(settings) {
      options = settings;
      return {
        async sendMail(mail) {
          message = mail;
          return { accepted: [mail.to], rejected: [] };
        },
        close() {
          closed++;
        },
      };
    },
  });
  await provider.send({
    destination: "previously-unlisted@example.invalid",
    code: "00123456",
    expiresAt: new Date("2026-10-05T15:10:00Z"),
  });
  assert.equal(options.host, "smtp.gmail.com");
  assert.equal(options.port, 465);
  assert.equal(options.secure, true);
  assert.equal(options.tls.rejectUnauthorized, true);
  assert.equal(options.tls.minVersion, "TLSv1.2");
  for (const setting of ["logger", "debug", "transactionLog"])
    assert.equal(options[setting], false);
  for (const setting of ["disableFileAccess", "disableUrlAccess"])
    assert.equal(options[setting], true);
  assert.equal(message.attachments, undefined);
  assert.equal(message.subject, "Verify your email — Cedar Staff");
  assert.match(message.html, /Verify your email address/);
  assert.match(message.html, /00123456/);
  assert.match(message.text, /00123456/);
  for (const content of [message.html, message.text])
    assert.ok(content.includes("5 October 2026 at 18:10:00 (Asia/Beirut)"));
  assert.equal(message.disableFileAccess, true);
  assert.equal(message.disableUrlAccess, true);
  assert.equal(closed, 1);
  await provider.send({
    destination: "another-unlisted@example.invalid",
    notification: true,
  });
  for (const content of [message.text, message.html]) {
    assert.match(content, /Your email address was changed/);
    assert.doesNotMatch(content, /00123456|password|birth|profile/i);
  }
  assert.equal(closed, 2);
});

test("provider rejection or internet failure returns only safe error and closes the transport", async () => {
  const value = enabledConfig();
  let closed = 0;
  for (const sendMail of [
    async () => {
      throw new Error("Synthetic private provider error");
    },
    async () => ({ accepted: [], rejected: ["synthetic@example.invalid"] }),
  ]) {
    const provider = createGmailDelivery({
      load: async () => value,
      transport: () => ({
        sendMail,
        close() {
          closed++;
        },
      }),
    });
    await assert.rejects(
      provider.send({
        destination: "synthetic@example.invalid",
        code: "12345678",
      }),
      (error) => {
        assert.equal(error.code, "contact_delivery_failed");
        assert.doesNotMatch(error.message, /12345678|private provider/);
        return true;
      },
    );
  }
  assert.equal(closed, 2);
});

test("private sender configuration is DPAPI protected, atomically replaced and starts disabled", async () => {
  const directory = await mkdtemp(join(tmpdir(), "capstone-contact-test-"));
  try {
    const value = config({ appPassword: "SyntheticOnly123" });
    await saveDeliveryConfig(value, { directory });
    const bytes = await readFile(join(directory, "gmail.dpapi"));
    assert.equal(bytes.includes(Buffer.from(value.appPassword)), false);
    assert.equal(bytes.includes(Buffer.from(value.sender)), false);
    assert.equal((await loadDeliveryConfig({ directory })).enabled, false);
    const legacy = {
      ...enabledConfig(),
      version: 1,
      recipients: ["old-selected@example.invalid"],
    };
    await saveDeliveryConfig(legacy, { directory });
    const approved = enableStaffSelfService(
      await loadDeliveryConfig({ directory }),
    );
    assert.equal(approved.approvalId, legacy.approvalId);
    assert.equal(approved.allowance, legacy.allowance);
    await saveDeliveryConfig(approved, { directory });
    assert.deepEqual(
      await loadDeliveryConfig({ directory }),
      validateDeliveryConfig(approved),
    );
    assert.deepEqual(await readdir(directory), ["gmail.dpapi"]);
    const wrong = Buffer.from("synthetic-invalid-wrapped-data");
    await assert.rejects(dpapi(wrong, "Unprotect"));
  } finally {
    // Exact owned mkdtemp directory only; never the existing authority/key store.
    assert.ok(directory.startsWith(join(tmpdir(), "capstone-contact-test-")));
    await rm(directory, { recursive: true, force: true });
  }
});
