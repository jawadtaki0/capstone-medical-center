import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, unlink, rmdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  provisionRequestConfig,
  loadRequestConfig,
  validateRequestConfig,
  createRequestTransport,
} from "../src/request-integration.js";
test("dedicated configuration requires confirmation, refuses overwrite and returns no credentials", async () => {
  const root = resolve(".local"),
    dir = join(root, `request-config-test-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  await mkdir(dir);
  const wrap = async (b) => Buffer.from(b.toString("base64")),
    unwrap = async (b) => Buffer.from(b.toString(), "base64"),
    protect = async () => {};
  try {
    await assert.rejects(
      provisionRequestConfig({
        directory: dir,
        contact: "SYNTHETIC",
        publicBase: "http://localhost:5173",
        wrap,
        protect,
      }),
    );
    const out = await provisionRequestConfig({
      directory: dir,
      contact: "SYNTHETIC TEST ONLY",
      publicBase: "http://localhost:5173",
      confirmed: true,
      wrap,
      protect,
    });
    assert.deepEqual(out, { configured: true });
    const before = await readFile(join(dir, "website-requests.dpapi"));
    const c = await loadRequestConfig({ directory: dir, unwrap });
    assert.equal(c.key.length, 32);
    assert.equal(c.credential.length, 43);
    await assert.rejects(
      provisionRequestConfig({
        directory: dir,
        contact: "Other",
        publicBase: "http://localhost:5173",
        confirmed: true,
        wrap,
        protect,
      }),
      { code: "EEXIST" },
    );
    assert.deepEqual(
      await readFile(join(dir, "website-requests.dpapi")),
      before,
    );
    assert.throws(() =>
      validateRequestConfig({
        ...c,
        key: c.key.toString("base64url"),
        limits: { submitMinute: 0 },
      }),
    );
  } finally {
    await unlink(join(dir, "website-requests.dpapi")).catch(() => {});
    await rmdir(dir);
  }
});
test("request transport refuses arbitrary destinations, redirects, and oversized responses", async () => {
  assert.throws(() =>
    createRequestTransport({
      mode: "test",
      target: "https://evil.test/api/requests/integration",
      credential: "a".repeat(43),
    }),
  );
  let used;
  const t = createRequestTransport(
    {
      mode: "test",
      target: "http://127.0.0.1:5192/api/requests/integration",
      credential: "a".repeat(43),
    },
    async (url, options) => {
      used = options;
      return new Response("x".repeat(600000));
    },
  );
  await assert.rejects(t.pull(0), /exceeded bound/);
  assert.equal(used.redirect, "error");
  assert.equal(used.headers.Origin, undefined);
});
