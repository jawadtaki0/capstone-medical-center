import test from "node:test";
import assert from "node:assert/strict";
import {
  createBroker,
  validateAuthorityUrl,
  sanitizedResult,
} from "../electron/transport.js";

test("HTTP is explicit loopback-only; remote/Atlas/credentials/redirect targets refused", () => {
  assert.equal(
    validateAuthorityUrl("http://127.0.0.1:4100", true),
    "http://127.0.0.1:4100",
  );
  for (const url of [
    "http://127.0.0.1:4100",
    "http://192.168.1.3:4100",
    "https://example.com:4100",
    "http://user:password@127.0.0.1:4100",
    "http://127.0.0.1:4100/other",
    "http://127.0.0.1:4000",
  ])
    assert.throws(() => validateAuthorityUrl(url, false));
  assert.throws(() => validateAuthorityUrl("http://192.168.1.3:4100", true));
});
test("session/challenge never reach renderer and polling never calls activity", async () => {
  const calls = [];
  const request = async (url, options) => {
    calls.push({ url, options });
    return Response.json(
      url.endsWith("/auth/login")
        ? {
            token: "private-token",
            challenge: "private-challenge",
            user: { username: "synthetic" },
          }
        : { user: { username: "synthetic" } },
    );
  };
  const broker = createBroker({
    url: "http://127.0.0.1:4100",
    demoMode: true,
    request,
  });
  const result = await broker.signIn({
    username: "synthetic",
    password: "synthetic test phrase",
  });
  assert.equal(result.token, undefined);
  assert.equal(result.challenge, undefined);
  await broker.sessionStatus();
  await broker.sessionStatus();
  assert.equal(
    calls.some((call) => call.url.endsWith("/auth/activity")),
    false,
  );
  assert.equal(calls[1].options.headers.Authorization, "Bearer private-token");
  await broker.signOut();
  await assert.rejects(broker.sessionStatus(), { code: "AUTH_REQUIRED" });
  assert.deepEqual(
    sanitizedResult({ token: "secret", challenge: "secret", kind: "mfa" }),
    { kind: "mfa" },
  );
});
test("authority loss refuses access rather than returning cached account", async () => {
  const broker = createBroker({
    url: "http://127.0.0.1:4100",
    demoMode: true,
    request: async () => {
      throw new Error("network");
    },
  });
  await assert.rejects(
    broker.signIn({ username: "synthetic", password: "not real" }),
    { code: "AUTHORITY_UNAVAILABLE" },
  );
});

test("late authentication responses cannot resurrect credentials after sign-out or forget", async () => {
  for (const action of ["signOut", "forget"]) {
    let finish;
    const request = async (url) =>
      url.endsWith("/auth/login")
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : Response.json({ signedOut: true });
    const broker = createBroker({
      url: "http://127.0.0.1:4100",
      demoMode: true,
      request,
    });
    const pending = broker.signIn({
      username: "synthetic",
      password: "synthetic test phrase",
    });
    await broker[action]();
    finish(
      Response.json({
        token: "synthetic-late-token",
        challenge: "synthetic-late-challenge",
        user: { username: "synthetic" },
      }),
    );
    await assert.rejects(pending, { code: "ACTION_SUPERSEDED" });
    await assert.rejects(broker.workspace(), { code: "AUTH_REQUIRED" });
    await assert.rejects(async () => broker.enrollment(), {
      code: "CHALLENGE_REQUIRED",
    });
  }
});

test("public health polling may finish during sign-in without cancelling the new credentials", async () => {
  let finish;
  const request = async (url) =>
    url.endsWith("/health")
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : Response.json(
          url.endsWith("/auth/login")
            ? {
                token: "synthetic-current-token",
                user: { username: "synthetic" },
              }
            : { heading: "Staff workspace" },
        );
  const broker = createBroker({
    url: "http://127.0.0.1:4100",
    demoMode: true,
    request,
  });
  const pending = broker.status();
  await broker.signIn({
    username: "synthetic",
    password: "synthetic test phrase",
  });
  finish(Response.json({ status: "ok", database: "connected" }));
  assert.equal((await pending).status, "ok");
  assert.equal((await broker.workspace()).heading, "Staff workspace");
});

test("management uses fixed protected routes and refuses URL/path injection", async () => {
  const calls = [];
  const request = async (url, options) => {
    calls.push({ url, options });
    return Response.json(
      url.endsWith("/auth/login")
        ? { token: "main-only-token" }
        : { staff: [] },
    );
  };
  const broker = createBroker({
    url: "http://127.0.0.1:4100",
    demoMode: true,
    request,
  });
  await assert.rejects(broker.staffDirectory(), { code: "AUTH_REQUIRED" });
  await broker.signIn({ username: "synthetic", password: "synthetic" });
  await broker.staffProfile({ accountId: "account:synthetic" });
  assert.equal(
    calls.at(-1).url,
    "http://127.0.0.1:4100/staff/account%3Asynthetic/profile",
  );
  assert.equal(
    calls.at(-1).options.headers.Authorization,
    "Bearer main-only-token",
  );
  const count = calls.length;
  for (const accountId of [
    "../profiles/me",
    "https://other.example",
    "account/x",
    "",
    { $ne: null },
  ]) {
    await assert.rejects(async () => broker.staffProfile({ accountId }), {
      code: "INVALID_ACTION",
    });
  }
  assert.equal(calls.length, count);
});

test("verification has separate main-memory challenge and a wrong factor does not discard a valid session", async () => {
  let refuse = true;
  const calls = [];
  const request = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/auth/login"))
      return Response.json({
        token: "synthetic-session",
        challenge: "synthetic-login",
      });
    if (url.endsWith("/reverify/start"))
      return Response.json({
        challenge: "synthetic-verification",
        kind: "verify",
      });
    if (url.endsWith("/reverify/complete") && refuse)
      return Response.json(
        {
          error: { code: "verification_failed", message: "Could not verify." },
        },
        { status: 401 },
      );
    return Response.json({ verified: true });
  };
  const broker = createBroker({
    url: "http://127.0.0.1:4100",
    demoMode: true,
    request,
  });
  await broker.signIn({ username: "synthetic", password: "synthetic" });
  assert.equal(
    (await broker.startVerification({ password: "synthetic" })).challenge,
    undefined,
  );
  await assert.rejects(
    broker.completeVerification({ method: "totp", code: "000000" }),
    { code: "verification_failed" },
  );
  await broker.workspace();
  assert.equal(
    calls.at(-1).options.headers.Authorization,
    "Bearer synthetic-session",
  );
  refuse = false;
  await broker.completeVerification({
    method: "backup",
    code: "synthetic-code",
  });
  assert.equal(
    JSON.parse(calls.at(-1).options.body).challenge,
    "synthetic-verification",
  );
  await broker.enrollment();
  assert.equal(
    JSON.parse(calls.at(-1).options.body).challenge,
    "synthetic-login",
  );
  await broker.signOut();
  await assert.rejects(
    async () => broker.completeVerification({ code: "unused" }),
    { code: "VERIFICATION_REQUIRED" },
  );
});

test("same-email and other-owner rejections preserve main-only pending contact proof and authorized session", async () => {
  for (const rejectionCode of [
    "contact_email_already_verified",
    "contact_email_in_use",
  ]) {
    const calls = [];
    let starts = 0;
    const broker = createBroker({
      url: "http://127.0.0.1:4100",
      demoMode: true,
      request: async (url, options) => {
        calls.push({ url, options });
        if (url.endsWith("/auth/login"))
          return Response.json({ token: "synthetic-session" });
        if (url.endsWith("/contacts/identity/start")) {
          if (++starts === 1)
            return Response.json({
              kind: "contact_identity",
              challenge: "synthetic-pending-contact",
            });
          return Response.json(
            {
              error: {
                code: rejectionCode,
                message:
                  "This email is already verified. Enter a different address to change it.",
              },
            },
            { status: 409 },
          );
        }
        return Response.json({ sent: true });
      },
    });
    await broker.signIn({ username: "synthetic", password: "synthetic" });
    const payload = {
      type: "email",
      destination: "synthetic@example.invalid",
      password: "synthetic",
      expectedRevision: 0,
    };
    assert.equal(
      (await broker.startContactIdentity(payload)).challenge,
      undefined,
    );
    await assert.rejects(broker.startContactIdentity(payload), {
      code: rejectionCode,
    });
    await broker.completeContactIdentity({
      type: "email",
      method: "totp",
      code: "synthetic",
    });
    assert.equal(
      JSON.parse(calls.at(-1).options.body).challenge,
      "synthetic-pending-contact",
    );
    assert.equal(
      calls.at(-1).options.headers.Authorization,
      "Bearer synthetic-session",
    );
    assert.equal(
      calls.some((call) => call.url.endsWith("/auth/activity")),
      false,
    );
  }
});

test("late same-email no-op cannot restore a contact proof after cancellation or forgetting credentials", async () => {
  for (const action of ["cancel", "forget"]) {
    let starts = 0,
      finish;
    const broker = createBroker({
      url: "http://127.0.0.1:4100",
      demoMode: true,
      request: async (url) => {
        if (url.endsWith("/auth/login"))
          return Response.json({ token: "synthetic-session" });
        if (url.endsWith("/contacts/identity/start")) {
          if (++starts === 1)
            return Response.json({
              kind: "contact_identity",
              challenge: "synthetic-pending-contact",
            });
          return new Promise((resolve) => {
            finish = resolve;
          });
        }
        return Response.json({ cancelled: true });
      },
    });
    await broker.signIn({ username: "synthetic", password: "synthetic" });
    const payload = {
      type: "email",
      destination: "synthetic@example.invalid",
      password: "synthetic",
      expectedRevision: 0,
    };
    await broker.startContactIdentity(payload);
    const pending = broker.startContactIdentity(payload);
    if (action === "forget") broker.forget();
    else await broker.cancelContactChange({ type: "email" });
    finish(
      Response.json(
        {
          error: {
            code: "contact_email_already_verified",
            message: "Already verified.",
          },
        },
        { status: 409 },
      ),
    );
    await assert.rejects(pending, {
      code:
        action === "forget"
          ? "ACTION_SUPERSEDED"
          : "contact_email_already_verified",
    });
    await assert.rejects(
      broker.completeContactIdentity({
        type: "email",
        method: "totp",
        code: "synthetic",
      }),
      { code: "contact_identity_required" },
    );
  }
});

test("contact proof stays in main memory, independent of manager proof; failures preserve valid session", async () => {
  const calls = [];
  let wrong = true;
  const request = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/auth/login"))
      return Response.json({ token: "synthetic-session" });
    if (url.endsWith("/reverify/start"))
      return Response.json({ challenge: "synthetic-manager" });
    if (url.endsWith("/contacts/identity/start"))
      return Response.json({
        challenge: "synthetic-contact",
        kind: "contact_identity",
      });
    if (url.endsWith("/contacts/identity/complete") && wrong)
      return Response.json(
        {
          error: {
            code: "contact_verification_failed",
            message: "Try a valid factor.",
          },
        },
        { status: 401 },
      );
    return Response.json({ sent: true });
  };
  const broker = createBroker({
    url: "http://127.0.0.1:4100",
    demoMode: true,
    request,
  });
  await broker.signIn({ username: "synthetic", password: "synthetic" });
  await broker.startVerification({ password: "synthetic" });
  assert.equal(
    (
      await broker.startContactIdentity({
        type: "email",
        destination: "synthetic@example.invalid",
        password: "synthetic",
        expectedRevision: 0,
      })
    ).challenge,
    undefined,
  );
  await assert.rejects(
    broker.completeContactIdentity({
      type: "email",
      method: "totp",
      code: "not-a-code",
    }),
    { code: "contact_verification_failed" },
  );
  await broker.contactStatus();
  assert.equal(
    calls.at(-1).options.headers.Authorization,
    "Bearer synthetic-session",
  );
  wrong = false;
  await broker.completeContactIdentity({
    type: "email",
    method: "backup",
    code: "synthetic-backup",
  });
  assert.equal(
    JSON.parse(calls.at(-1).options.body).challenge,
    "synthetic-contact",
  );
  await broker.completeVerification({
    method: "totp",
    code: "synthetic-factor",
  });
  assert.equal(
    JSON.parse(calls.at(-1).options.body).challenge,
    "synthetic-manager",
  );
  assert.equal(
    calls.some((call) => call.url.endsWith("/auth/activity")),
    false,
  );
  await broker.startContactIdentity({
    type: "email",
    destination: "synthetic@example.invalid",
    password: "synthetic",
    expectedRevision: 0,
  });
  await broker.cancelContactChange({ type: "email" });
  await assert.rejects(
    broker.completeContactIdentity({
      type: "email",
      method: "totp",
      code: "synthetic",
    }),
    { code: "contact_identity_required" },
  );
  await broker.signOut();
  await assert.rejects(broker.contactStatus(), { code: "AUTH_REQUIRED" });
});
