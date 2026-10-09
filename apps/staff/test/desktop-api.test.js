import assert from "node:assert/strict";
import test from "node:test";
import { createDesktopApi } from "../src/lib/desktopApi.js";

test("desktop adapter unwraps plain bridge results without adding token storage", async () => {
  const calls = [];
  const api = createDesktopApi({
    status: async (payload) => {
      calls.push(payload);
      return { ok: true, result: { status: "ok" } };
    },
  });
  assert.equal(Object.isFrozen(api), true);
  assert.deepEqual(await api.status(), { status: "ok" });
  assert.deepEqual(calls, [undefined]);
  assert.deepEqual(Object.keys(api), ["status"]);
  assert.equal(createDesktopApi(undefined), undefined);
});

test("copied plain errors keep verification and session codes in the renderer", async () => {
  for (const code of [
    "verification_required",
    "verification_failed",
    "authentication_failed",
    "try_later",
  ]) {
    const envelope = JSON.parse(
      JSON.stringify({
        ok: false,
        error: { code, message: "Synthetic safe denial." },
      }),
    );
    const api = createDesktopApi({ action: async () => envelope });
    await assert.rejects(api.action(), {
      code,
      message: "Synthetic safe denial.",
    });
  }
});

test("broken bridges fail closed and never expose underlying IPC error details", async () => {
  for (const action of [
    async () => {
      throw new Error("must-not-display");
    },
    async () => null,
    async () => ({ status: "ok" }),
  ]) {
    const api = createDesktopApi({ action });
    await assert.rejects(
      api.action(),
      (error) =>
        error.code === "AUTHORITY_UNAVAILABLE" &&
        !error.message.includes("must-not-display"),
    );
  }
  await assert.rejects(
    createDesktopApi({
      action: async () => ({ ok: false, error: {} }),
    }).action(),
    { code: "INVALID_ACTION" },
  );
});
