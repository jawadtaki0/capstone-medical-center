import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, unlink, rmdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  createRequestTransport,
  validateRequestConfig,
  validateHostedReviewRequestConfig,
  loadRequestConfig,
  loadHostedReviewRequestConfig,
  provisionHostedReviewRequestConfig,
  startHostedReviewRequestWorker,
} from "../src/request-integration.js";
import {
  validateReceiverTarget,
  createPublicationWorker,
} from "../src/publication-delivery.js";

const environment = () => ({
  mode: "hosted-review",
  apiOrigin: "https://cedar-capstone-review.onrender.com",
  publicBase: "https://cedar-capstone-review.vercel.app",
  publicDatabase: "capstone_public_review",
  publicSrvHost: "synthetic.example.mongodb.net",
  streamId: "stream:11111111-1111-4111-8111-111111111111",
});
const config = () => ({
  ...environment(),
  version: 1,
  target: environment().apiOrigin + "/api/requests/integration",
  contact: "SYNTHETIC REVIEW ONLY",
  credential: "a".repeat(43),
  key: "b".repeat(43),
  manualRefreshOnly: true,
});

test("hosted request/publication transports require the exact reviewed HTTPS origin and namespace", () => {
  assert.doesNotThrow(() =>
    createRequestTransport(config(), async () => new Response("{}")),
  );
  assert.equal(
    validateReceiverTarget(
      environment().apiOrigin + "/api/publications",
      true,
      environment(),
    ),
    environment().apiOrigin + "/api/publications",
  );
  for (const target of [
    "http://cedar-capstone-review.onrender.com/api/requests/integration",
    "https://other.onrender.com/api/requests/integration",
    "https://cedar-capstone-review.onrender.com.evil.example/api/requests/integration",
    "https://user:secret@cedar-capstone-review.onrender.com/api/requests/integration",
    config().target + "?x=1",
    config().target + "#x",
    config().target + "/other",
  ])
    assert.throws(() => createRequestTransport({ ...config(), target }));
  assert.throws(() =>
    createRequestTransport({
      ...config(),
      publicDatabase: "medical-center-dev",
    }),
  );
  assert.throws(() =>
    validateReceiverTarget(
      environment().apiOrigin + "/api/publications?x=1",
      true,
      environment(),
    ),
  );
  assert.throws(() =>
    validateReceiverTarget(
      environment().apiOrigin + "/api/publications",
      true,
      { ...environment(), streamId: "other" },
    ),
  );
});

test("local and TEST transports retain loopback restrictions and cannot silently accept hosted mode", () => {
  assert.throws(() => validateRequestConfig(config()));
  assert.throws(() =>
    createRequestTransport({ ...config(), mode: "normal-local" }),
  );
  assert.throws(() =>
    validateReceiverTarget(
      environment().apiOrigin + "/api/publications",
      true,
      { mode: "test" },
    ),
  );
  assert.equal(
    validateReceiverTarget("http://127.0.0.1:5199/api/publications", true),
    "http://127.0.0.1:5199/api/publications",
  );
});

test("hosted cold-start wait is bounded75seconds, local remains5seconds, no redirect or automatic retry", async (t) => {
  const periods = [];
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, "timeout", (milliseconds) => {
    periods.push(milliseconds);
    return timeout(milliseconds);
  });
  let calls = 0,
    used;
  const response = async (_url, options) => {
    calls++;
    used = options;
    return new Response("{}");
  };
  await createRequestTransport(config(), response).pull(0);
  assert.equal(used.redirect, "error");
  assert.equal(used.headers.Authorization, `Bearer ${config().credential}`);
  assert.equal(used.headers.Origin, undefined);
  await createRequestTransport(
    {
      mode: "test",
      target: "http://127.0.0.1:5199/api/requests/integration",
      credential: config().credential,
    },
    response,
  ).pull(0);
  assert.deepEqual(periods, [75000, 5000]);
  const failed = createRequestTransport(config(), async () => {
    calls++;
    throw new Error("sensitive provider details");
  });
  await assert.rejects(failed.pull(0), (e) => !e.message.includes("sensitive"));
  assert.equal(calls, 3);
});

test("hosted transport retains bounded response and controlled failed status", async () => {
  await assert.rejects(
    createRequestTransport(
      config(),
      async () => new Response("x".repeat(600000)),
    ).pull(0),
    /exceeded bound/,
  );
  await assert.rejects(
    createRequestTransport(
      config(),
      async () => new Response("provider detail", { status: 503 }),
    ).pull(0),
    (e) => e.status === 503 && !e.message.includes("detail"),
  );
  await assert.rejects(
    createRequestTransport(
      config(),
      async () => new Response("secret provider response must not escape"),
    ).pull(0),
    (e) => !e.message.includes("secret") && /invalid/.test(e.message),
  );
});

test("protected review configuration is separate, explicit, no-overwrite and does not alter normal configuration", async () => {
  const directory = resolve(".local", `hosted-request-config-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const normalFile = join(directory, "website-requests.dpapi");
  const reviewFile = join(directory, "website-requests-hosted-review.dpapi");
  const wrap = async (b) => Buffer.from(b.toString("base64")),
    unwrap = async (b) => Buffer.from(b.toString(), "base64"),
    protect = async () => {};
  try {
    const normal = Buffer.from("preserved mock normal bytes");
    await writeFile(normalFile, normal);
    await assert.rejects(
      provisionHostedReviewRequestConfig({
        config: config(),
        directory,
        wrap,
        protect,
      }),
    );
    const result = await provisionHostedReviewRequestConfig({
      config: config(),
      directory,
      confirmed: true,
      wrap,
      protect,
    });
    assert.deepEqual(result, {
      configured: true,
      mode: "hosted-review",
      manualRefreshOnly: true,
    });
    const saved = await readFile(reviewFile);
    assert.deepEqual(await readFile(normalFile), normal);
    const loaded = await loadHostedReviewRequestConfig({ directory, unwrap });
    assert.equal(loaded.mode, "hosted-review");
    assert.equal(loaded.key.length, 32);
    assert.equal(loaded.manualRefreshOnly, true);
    await assert.rejects(
      provisionHostedReviewRequestConfig({
        config: config(),
        directory,
        confirmed: true,
        wrap,
        protect,
      }),
      { code: "EEXIST" },
    );
    assert.deepEqual(await readFile(reviewFile), saved);
    await writeFile(normalFile, saved);
    await assert.rejects(loadRequestConfig({ directory, unwrap }));
    assert.throws(() =>
      validateHostedReviewRequestConfig({
        ...config(),
        manualRefreshOnly: false,
      }),
    );
    assert.throws(() =>
      validateHostedReviewRequestConfig({
        ...config(),
        uri: "unnecessary cloud URI",
      }),
    );
  } finally {
    await unlink(normalFile).catch(() => {});
    await unlink(reviewFile).catch(() => {});
    await rmdir(directory);
  }
});

test("review request worker has no startup/idle polling and only explicit runOnce calls the service", async (t) => {
  let calls = 0;
  let timers = 0;
  t.mock.method(globalThis, "setTimeout", () => {
    timers++;
    return { unref() {} };
  });
  const worker = startHostedReviewRequestWorker({
    pump: async () => {
      calls++;
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 0);
  await worker.runOnce();
  assert.equal(calls, 1);
  assert.equal(timers, 0);
  await worker.stop();
  await worker.runOnce();
  assert.equal(calls, 1);
});

test("publication hosted lease covers cold-start deadline and uses authenticated exact target without redirects", async (t) => {
  const periods = [];
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, "timeout", (milliseconds) => {
    periods.push(milliseconds);
    return timeout(milliseconds);
  });
  const env = environment(),
    at = new Date("2026-10-29T12:00:00Z"),
    digest = "f".repeat(64);
  let lease, used;
  const job = {
    _id: "synthetic-publication",
    streamId: env.streamId,
    sequence: 1,
    digest,
    attempts: 1,
    payload: { schemaVersion: 2 },
  };
  const outbox = {
    findOneAndUpdate: async (_filter, update) => {
      lease = update.$set.leaseUntil;
      return job;
    },
    updateOne: async () => ({ modifiedCount: 1 }),
    updateMany: async () => ({ modifiedCount: 0 }),
  };
  const db = { databaseName: "capstone_staff_test", collection: () => outbox };
  const client = {
    options: {
      hosts: [{ host: "127.0.0.1", port: 27018 }],
      replicaSet: "capstoneStaffDev",
    },
    startSession: () => ({
      withTransaction: async (action) => action(),
      endSession: async () => {},
    }),
  };
  const worker = createPublicationWorker({
    db,
    client,
    target: env.apiOrigin + "/api/publications",
    token: config().credential,
    streamId: env.streamId,
    environment: env,
    demoMode: true,
    automatic: false,
    clock: () => at,
    request: async (url, options) => {
      used = { url, options };
      return new Response(
        JSON.stringify({
          accepted: true,
          schemaVersion: 2,
          streamId: env.streamId,
          sequence: 1,
          digest,
        }),
      );
    },
  });
  assert.deepEqual(await worker.tick(), { accepted: true, sequence: 1 });
  assert.equal(used.url, env.apiOrigin + "/api/publications");
  assert.equal(used.options.redirect, "error");
  assert.equal(
    used.options.headers.Authorization,
    `Bearer ${config().credential}`,
  );
  assert.deepEqual(periods, [75000]);
  assert.equal(+lease - +at, 90000);
  await worker.stop();
});
