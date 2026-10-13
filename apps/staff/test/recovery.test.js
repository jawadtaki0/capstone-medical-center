import assert from "node:assert/strict";
import { test } from "node:test";
import { createBroker } from "../electron/transport.js";

test("recovery authority stays in main; proof steps never create a workspace session", async () => {
  const calls = [];
  const broker = createBroker({
    url: "http://127.0.0.1:4101",
    demoMode: true,
    request: async (url, options) => {
      calls.push({
        path: new URL(url).pathname,
        body: options.body && JSON.parse(options.body),
      });
      return Response.json({
        challenge: "dummy-recovery-token",
        kind: "recovery_ready",
      });
    },
  });
  assert.equal(
    (await broker.requestRecovery({ username: "synthetic" })).challenge,
    undefined,
  );
  assert.equal(
    (await broker.verifyRecovery({ code: "00123456" })).challenge,
    undefined,
  );
  assert.equal(calls.at(-1).body.code, "00123456");
  assert.equal(calls.at(-1).body.challenge, "dummy-recovery-token");
  await assert.rejects(broker.workspace(), { code: "AUTH_REQUIRED" });
  await broker.cancelRecovery();
  await assert.rejects(broker.recoveryEnrollment(), {
    code: "recovery_expired",
  });
});
for (const boundary of ["request", "enrollment"]) {
  test(`delayed ${boundary} cannot restore private recovery after cancellation`, async () => {
    let finish;
    const broker = createBroker({
      url: "http://127.0.0.1:4101",
      demoMode: true,
      request: async (url) => {
        if (new URL(url).pathname === `/recovery/${boundary}`)
          return new Promise((resolve) => {
            finish = resolve;
          });
        return Response.json({ challenge: "dummy", cancelled: true });
      },
    });
    if (boundary === "enrollment")
      await broker.requestRecovery({ username: "synthetic" });
    const pending =
      boundary === "request"
        ? broker.requestRecovery({ username: "synthetic" })
        : broker.recoveryEnrollment();
    await broker.cancelRecovery();
    finish(
      Response.json({
        challenge: boundary === "request" ? "late-dummy" : undefined,
        secret: "DUMMY-SEED",
        kind: "recovery_enroll",
      }),
    );
    await assert.rejects(pending, { code: "ACTION_SUPERSEDED" });
    await assert.rejects(broker.recoveryStatus(), { code: "recovery_expired" });
  });
}
test("busy refusal preserves main's authority for a later retry", async () => {
  let busy = true;
  const broker = createBroker({
    url: "http://127.0.0.1:4101",
    demoMode: true,
    request: async (url) => {
      if (url.endsWith("/request"))
        return Response.json({ challenge: "dummy", kind: "recovery_ready" });
      if (busy)
        return Response.json(
          {
            error: {
              code: "recovery_busy",
              message: "Try again; your entries are kept.",
            },
          },
          { status: 409 },
        );
      return Response.json({ completed: true });
    },
  });
  await broker.requestRecovery({ username: "synthetic" });
  await assert.rejects(
    broker.saveRecoveryPassword({
      newPassword: "Dummy",
      confirmation: "Dummy",
    }),
    { code: "recovery_busy" },
  );
  busy = false;
  assert.equal(
    (
      await broker.saveRecoveryPassword({
        newPassword: "Dummy",
        confirmation: "Dummy",
      })
    ).completed,
    true,
  );
  await assert.rejects(broker.recoveryStatus(), { code: "recovery_expired" });
});
test("failed cancellation retains only a retryable cancellation capability, never usable recovery access", async () => {
  const cancellations = [];
  const broker = createBroker({
    url: "http://127.0.0.1:4101",
    demoMode: true,
    request: async (url, options) => {
      if (url.endsWith("/request"))
        return Response.json({ challenge: "dummy-private-capability" });
      if (url.endsWith("/cancel")) {
        cancellations.push(JSON.parse(options.body).challenge);
        if (cancellations.length === 1)
          return Response.json(
            { error: { code: "unavailable", message: "Dummy unavailable" } },
            { status: 503 },
          );
        return Response.json({ cancelled: true });
      }
      throw Error("Unexpected access");
    },
  });
  await broker.requestRecovery({ username: "synthetic" });
  await assert.rejects(broker.cancelRecovery(), { code: "unavailable" });
  await assert.rejects(broker.recoveryStatus(), { code: "recovery_expired" });
  await broker.cancelRecovery();
  assert.deepEqual(cancellations, [
    "dummy-private-capability",
    "dummy-private-capability",
  ]);
});
