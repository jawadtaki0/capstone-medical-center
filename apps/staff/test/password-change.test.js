import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { createBroker } from "../electron/transport.js";
import { observeChallenge, sessionTiming } from "../src/lib/activity.js";

function fixture(handler) {
  const calls = [];
  const broker = createBroker({
    url: "http://127.0.0.1:4101",
    demoMode: true,
    request: async (url, options) => {
      const path = new URL(url).pathname,
        body = options.body ? JSON.parse(options.body) : undefined;
      calls.push({ path, body });
      if (path === "/auth/login")
        return Response.json({ token: "dummy-test-session" });
      return handler(path, body);
    },
  });
  return { broker, calls };
}
test("password proof remains in main memory; busy/cooldown/allowance do not discard authorized session or proof", async () => {
  for (const code of [
    "password_change_busy",
    "password_change_cooldown",
    "password_change_allowance",
    "password_reused",
  ]) {
    let refused = true;
    const { broker, calls } = fixture((path) => {
      if (path === "/password/change/start")
        return Response.json({
          challenge: "dummy-test-proof",
          kind: "password_ready",
        });
      if (path === "/password/change/complete" && refused) {
        refused = false;
        return Response.json(
          { error: { code, message: "Safe distinct message" } },
          { status: 409 },
        );
      }
      if (path === "/password/change/complete")
        return Response.json({ passwordChanged: true });
      return Response.json({ user: { username: "synthetic" } });
    });
    await broker.signIn({});
    assert.equal(
      (await broker.startPasswordChange({ password: "Dummy only password" }))
        .challenge,
      undefined,
    );
    const payload = {
      newPassword: "Dummy new password value",
      confirmation: "Dummy new password value",
    };
    await assert.rejects(broker.savePasswordChange(payload), { code });
    await broker.sessionStatus();
    assert.ok((await broker.savePasswordChange(payload)).passwordChanged);
    const saves = calls.filter(
      (call) => call.path === "/password/change/complete",
    );
    assert.equal(saves[0].body.challenge, saves[1].body.challenge);
    await assert.rejects(broker.sessionStatus(), { code: "AUTH_REQUIRED" });
    assert.throws(() => broker.completePasswordIdentity({}), {
      code: "password_change_expired",
    });
  }
});
for (const action of ["cancelPasswordChange", "signOut", "forget"]) {
  test(`late password authorization cannot return after ${action}`, async () => {
    let finish;
    const { broker } = fixture((path) =>
      path === "/password/change/start"
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : Response.json({ cancelled: true }),
    );
    await broker.signIn({});
    const pending = broker.startPasswordChange({
      password: "Dummy private input",
    });
    await broker[action]();
    finish(
      Response.json({ challenge: "late-dummy-proof", kind: "password_ready" }),
    );
    await assert.rejects(pending, { code: "ACTION_SUPERSEDED" });
    await assert.rejects(broker.savePasswordChange({}), {
      code: "password_change_expired",
    });
  });
}
test("password authorization deadline uses actual server deadline despite delayed timers", () => {
  const observedAt = 10000;
  const proof = observeChallenge(
    { serverNow: "2026-10-12T08:00:00Z", expiresAt: "2026-10-12T08:05:00Z" },
    observedAt,
  );
  assert.equal(sessionTiming(proof, observedAt + 299999).expired, false);
  assert.equal(sessionTiming(proof, observedAt + 300000).expired, true);
  assert.equal(sessionTiming(proof, observedAt + 600000).expired, true);
});
test("popup uses named bridge actions, exact confirmation, native focus trap and no extra dependencies", async () => {
  const source = await readFile(
    new URL("../src/components/PasswordChange.jsx", import.meta.url),
    "utf8",
  );
  const preload = await readFile(
    new URL("../electron/preload.cjs", import.meta.url),
    "utf8",
  );
  for (const name of [
    "startPasswordChange",
    "completePasswordIdentity",
    "savePasswordChange",
    "cancelPasswordChange",
  ]) {
    assert.ok(source.includes(`api.${name}`));
    assert.ok(preload.includes(`"${name}"`));
  }
  assert.ok(source.includes("showModal()"));
  assert.ok(source.includes("aria-labelledby"));
  assert.ok(source.includes("newPassword !== confirmation"));
  assert.ok(source.includes("returnFocus.current?.focus"));
  assert.ok(source.includes('failure.code !== "password_change_busy"'));
  assert.ok(!source.includes("localStorage"));
  assert.ok(!source.includes("console."));
});
