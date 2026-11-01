import test from "node:test";
import assert from "node:assert/strict";
import { createBroker } from "../electron/transport.js";

async function setup({
  expired = false,
  openingFails = false,
  recordFails = false,
} = {}) {
  const calls = [],
    opens = [];
  const broker = createBroker({
    url: "http://127.0.0.1:4100",
    demoMode: true,
    request: async (url, options) => {
      calls.push({
        path: new URL(url).pathname,
        body: options.body ? JSON.parse(options.body) : undefined,
      });
      if (url.endsWith("/auth/login"))
        return Response.json({ token: "dummy-session" });
      if (url.endsWith("/contacts/phone/prepare"))
        return Response.json({
          phone: "+96171123456",
          message: "Dummy verification code 00123456",
          generation: "dummy-generation",
          expiresAt: new Date(
            Date.now() + (expired ? -1000 : 60000),
          ).toISOString(),
        });
      if (recordFails)
        return Response.json(
          { error: { code: "unavailable", message: "Unavailable" } },
          { status: 503 },
        );
      return Response.json({ opened: true });
    },
    openWhatsApp: async (phone, message) => {
      if (openingFails) throw Error("Dummy failure");
      opens.push({ phone, message });
    },
  });
  await broker.signIn({ username: "synthetic", password: "dummy-only" });
  return { broker, calls, opens };
}

test("staff phone broker accepts only target ID and keeps prepared code and destination out of renderer result", async () => {
  const { broker, calls, opens } = await setup();
  for (const invalid of [
    { accountId: "synthetic", url: "https://example.invalid" },
    { accountId: "synthetic", phone: "+96171123456" },
    { accountId: "synthetic", message: "injected" },
  ])
    await assert.rejects(broker.openStaffPhoneWhatsApp(invalid));
  assert.equal(calls.length, 1);
  const result = await broker.openStaffPhoneWhatsApp({
    accountId: "synthetic",
  });
  assert.equal(result.opened, true);
  assert.equal(opens.length, 1);
  assert.deepEqual(
    calls.slice(1).map((x) => x.path),
    ["/contacts/phone/prepare", "/contacts/phone/opened"],
  );
  assert.deepEqual(calls.at(-1).body, {
    accountId: "synthetic",
    generation: "dummy-generation",
  });
  for (const secret of [
    "00123456",
    "+96171123456",
    "dummy-generation",
    "Dummy verification",
  ])
    assert(!JSON.stringify(result).includes(secret));
});

test("expired staff phone preparation cannot open WhatsApp or record opening", async () => {
  const { broker, calls, opens } = await setup({ expired: true });
  await assert.rejects(
    broker.openStaffPhoneWhatsApp({ accountId: "synthetic" }),
    /expired/,
  );
  assert.equal(opens.length, 0);
  assert.equal(calls.length, 2);
});

test("external opening failure never records opened and uncertain recording never claims sent", async () => {
  const failed = await setup({ openingFails: true });
  await assert.rejects(
    failed.broker.openStaffPhoneWhatsApp({ accountId: "synthetic" }),
  );
  assert.equal(failed.calls.length, 2);
  const uncertain = await setup({ recordFails: true });
  const result = await uncertain.broker.openStaffPhoneWhatsApp({
    accountId: "synthetic",
  });
  assert.equal(result.opened, true);
  assert.match(result.warning, /could not be recorded/);
  assert.equal(result.sent, undefined);
});

test("a delayed phone preparation cannot open after sign-out", async () => {
  let resolvePreparation;
  let opened = false;
  const broker = createBroker({
    url: "http://127.0.0.1:4100",
    demoMode: true,
    request: async (url) =>
      url.endsWith("/auth/login")
        ? Response.json({ token: "dummy-session" })
        : new Promise((resolve) => {
            resolvePreparation = resolve;
          }),
    openWhatsApp: async () => {
      opened = true;
    },
  });
  await broker.signIn({ username: "synthetic", password: "dummy-only" });
  const pending = broker.openStaffPhoneWhatsApp({ accountId: "synthetic" });
  broker.forget();
  resolvePreparation(
    Response.json({
      phone: "+96171123456",
      message: "Dummy 00123456",
      generation: "dummy-generation",
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    }),
  );
  await assert.rejects(pending);
  assert.equal(opened, false);
});
