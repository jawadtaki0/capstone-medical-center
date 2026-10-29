import test from "node:test";
import assert from "node:assert/strict";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import {
  validateHostedReviewConfig,
  hostedReviewIdentity,
} from "../../../shared/hosted-review-config.mjs";
import {
  loadHostedReviewEnvironment,
  createHostedReviewRuntime,
  createHostedReviewApp,
} from "../src/hosted-review.js";
import { assertPublicationStorage } from "../../../shared/publication-environment.mjs";
import { createPublicationReceiver } from "../src/publication-receiver.js";
import {
  createRenderReviewSource,
  startHostedReviewServer,
} from "../src/hosted-review-server.js";
import { EventEmitter } from "node:events";

const config = () => ({
  mode: "hosted-review",
  apiOrigin: "https://cedar-capstone-review.onrender.com",
  publicBase: "https://cedar-capstone-review.vercel.app",
  publicDatabase: "capstone_public_review",
  publicSrvHost: "synthetic.example.mongodb.net",
  streamId: "stream:11111111-1111-4111-8111-111111111111",
});
const environment = () => ({
  CEDAR_REVIEW_API_ORIGIN: config().apiOrigin,
  CEDAR_REVIEW_PUBLIC_ORIGIN: config().publicBase,
  CEDAR_REVIEW_DATABASE: config().publicDatabase,
  CEDAR_REVIEW_ATLAS_SRV_HOST: config().publicSrvHost,
  CEDAR_REVIEW_STREAM_ID: config().streamId,
  CEDAR_REVIEW_PUBLICATION_TOKEN: "a".repeat(43),
  CEDAR_REVIEW_REQUEST_CREDENTIAL: "b".repeat(43),
  CEDAR_REVIEW_REQUEST_KEY: "c".repeat(43),
  CEDAR_REVIEW_CENTER_CONTACT: "SYNTHETIC REVIEW — no real patient submissions",
  CEDAR_REVIEW_MONGODB_URI:
    "mongodb+srv://dummy:dummy@synthetic.example.mongodb.net/capstone_public_review?tls=true",
});

test("hosted review origin/namespace contract rejects local, normal and arbitrary destinations", () => {
  assert.equal(
    validateHostedReviewConfig(config()).publicDatabase,
    "capstone_public_review",
  );
  for (const patch of [
    { apiOrigin: "http://cedar.onrender.com" },
    { apiOrigin: "https://cedar.onrender.com.evil.example" },
    { apiOrigin: "https://user:pass@cedar.onrender.com" },
    { apiOrigin: "https://cedar.onrender.com/api" },
    { apiOrigin: "https://cedar.onrender.com?x=1" },
    { apiOrigin: "https://cedar.onrender.com#x" },
    { publicBase: "http://localhost:5173" },
    { publicBase: "https://arbitrary.example" },
    { publicDatabase: "medical-center-dev" },
    { mode: "normal-local" },
  ])
    assert.throws(() => validateHostedReviewConfig({ ...config(), ...patch }));
  assert.equal(
    hostedReviewIdentity(config()),
    hostedReviewIdentity({ ...config(), secretIgnored: "not identity" }),
  );
});

test("hosted environment loader uses only dedicated explicit secrets and verified TLS Atlas URI", () => {
  const c = loadHostedReviewEnvironment(environment());
  assert.equal(c.key.length, 32);
  assert.equal(c.environment.publicTarget.database, "capstone_public_review");
  assert.notEqual(c.publicationToken, c.requestCredential);
  for (const patch of [
    { CEDAR_REVIEW_REQUEST_KEY: "" },
    {
      CEDAR_REVIEW_PUBLICATION_TOKEN:
        environment().CEDAR_REVIEW_REQUEST_CREDENTIAL,
    },
    {
      CEDAR_REVIEW_MONGODB_URI:
        environment().CEDAR_REVIEW_MONGODB_URI +
        "&tlsAllowInvalidCertificates=true",
    },
    {
      CEDAR_REVIEW_MONGODB_URI: environment().CEDAR_REVIEW_MONGODB_URI.replace(
        "tls=true",
        "tls=false",
      ),
    },
    {
      CEDAR_REVIEW_MONGODB_URI: environment().CEDAR_REVIEW_MONGODB_URI.replace(
        "capstone_public_review",
        "medical-center-dev",
      ),
    },
  ])
    assert.throws(
      () => loadHostedReviewEnvironment({ ...environment(), ...patch }),
      (e) => !e.message.includes("dummy"),
    );
  assert.throws(() =>
    loadHostedReviewEnvironment({
      MONGODB_URI: environment().CEDAR_REVIEW_MONGODB_URI,
    }),
  );
});

test("hosted public storage guard requires the exact review Atlas namespace and TLS", () => {
  const c = loadHostedReviewEnvironment(environment());
  const db = { databaseName: "capstone_public_review" },
    client = { options: { srvHost: config().publicSrvHost, tls: true } };
  assert.doesNotThrow(() =>
    assertPublicationStorage(db, client, true, "public", c.environment),
  );
  assert.throws(() =>
    assertPublicationStorage(
      { databaseName: "medical-center-dev" },
      client,
      true,
      "public",
      c.environment,
    ),
  );
  assert.throws(() =>
    assertPublicationStorage(
      db,
      { options: { ...client.options, tlsAllowInvalidCertificates: true } },
      true,
      "public",
      c.environment,
    ),
  );
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const fake = (ping = async () => {}) => {
  const calls = { connect: 0, close: 0, writes: 0 };
  const db = { databaseName: "capstone_public_review", command: ping };
  return {
    calls,
    db: () => db,
    connect: async () => {
      calls.connect++;
    },
    close: async () => {
      calls.close++;
    },
  };
};

test("concurrent hosted requests share bounded initialization and reuse the same healthy pool", async () => {
  const gate = deferred(),
    client = fake();
  let bindings = 0;
  const runtime = createHostedReviewRuntime({
    config: loadHostedReviewEnvironment(environment()),
    makeClient: () => client,
    bind: async () => {
      bindings++;
      await gate.promise;
      return { synthetic: true };
    },
  });
  const a = runtime.ready(),
    b = runtime.ready();
  await new Promise((r) => setImmediate(r));
  assert.equal(client.calls.connect, 1);
  assert.equal(bindings, 1);
  gate.resolve();
  assert.deepEqual(await a, { synthetic: true });
  assert.equal(await b, await runtime.ready());
  assert.equal(bindings, 1);
  await runtime.close();
  assert.equal(client.calls.close, 1);
});

test("failed initialization recovers without background timers or stale completions restoring old state", async () => {
  const first = fake(),
    second = fake(),
    gate = deferred();
  let tries = 0;
  const runtime = createHostedReviewRuntime({
    config: loadHostedReviewEnvironment(environment()),
    makeClient: () => (tries++ === 0 ? first : second),
    bind: async ({ client }) =>
      client === first ? gate.promise : { recovered: true },
  });
  const stale = runtime.ready();
  await new Promise((r) => setImmediate(r));
  await runtime.invalidate();
  assert.deepEqual(await runtime.ready(), { recovered: true });
  gate.resolve({ obsolete: true });
  await assert.rejects(stale, /unavailable/);
  assert.deepEqual(await runtime.ready(), { recovered: true });
  assert.equal(first.calls.close, 1);
  await runtime.close();
});

function receiverFixture({ marker = true, mode = "cedar" } = {}) {
  const c = loadHostedReviewEnvironment(environment());
  let reads = 0;
  const db = {
    databaseName: c.publicDatabase,
    collection(name) {
      return {
        findOne: async (q) => {
          reads++;
          if (name === "hosted_review_configuration")
            return marker
              ? {
                  _id: "review",
                  version: 1,
                  status: "ready",
                  configDigest: hostedReviewIdentity(c),
                }
              : null;
          if (name === "public_data_authority")
            return { mode, streamId: c.streamId, revision: 7 };
          if (name === "public_publication_state" && q._id === c.streamId)
            return { sequence: 1, revision: 1 };
          return null;
        },
      };
    },
  };
  const client = { options: { srvHost: c.publicSrvHost, tls: true } };
  return { c, db, client, reads: () => reads };
}

test("hosted publication binding is read-only, requires provisioned authority and authenticates exact host/token", async () => {
  const f = receiverFixture(),
    c = f.c;
  const create = (value) =>
    createPublicationReceiver({
      ...value,
      token: c.publicationToken,
      streamId: c.streamId,
      demoMode: true,
      environment: c.environment,
    });
  const receiver = await create(f);
  await create(f);
  assert(f.reads() >= 8);
  const request = (headers = {}) => ({
    get: (name) =>
      ({
        Authorization: `Bearer ${c.publicationToken}`,
        Host: new URL(c.apiOrigin).host,
        ...headers,
      })[name],
    socket: { remoteAddress: "203.0.113.1" },
    hostname: new URL(c.apiOrigin).hostname,
  });
  assert.equal(receiver.authorized(request()), true);
  assert.equal(receiver.authorized(request({ Origin: c.publicBase })), false);
  assert.equal(
    receiver.authorized(request({ Host: "other.onrender.com" })),
    false,
  );
  assert.equal(
    receiver.authorized(request({ Authorization: "Bearer " + "x".repeat(43) })),
    false,
  );
  await assert.rejects(
    create(receiverFixture({ marker: false })),
    /provisioned/,
  );
  await assert.rejects(
    create(receiverFixture({ mode: "legacy" })),
    /provisioned/,
  );
});

function invoke(app, url = "/api/health") {
  return new Promise((resolve, reject) => {
    const request = new IncomingMessage(new Socket());
    Object.assign(request, {
      method: "GET",
      url,
      headers: { host: new URL(config().apiOrigin).host },
    });
    const response = new ServerResponse(request);
    response.end = (body) => {
      try {
        resolve({
          status: response.statusCode,
          headers: response.getHeaders(),
          body: JSON.parse(body),
        });
      } catch (error) {
        reject(error);
      }
    };
    app(request, response, reject);
  });
}

test("hosted readiness failure returns controlled private 503 without credential/provider details", async () => {
  const c = loadHostedReviewEnvironment(environment());
  const { app } = createHostedReviewApp({
    config: c,
    runtime: {
      ready: async () => {
        throw new Error(c.uri);
      },
    },
    sourceReader: () => "synthetic",
  });
  const response = await invoke(app);
  assert.equal(response.status, 503);
  assert.equal(response.body.error, "review_unavailable");
  assert(!JSON.stringify(response).includes("dummy"));
  assert.equal(response.headers["cache-control"], "private, no-store");
  assert.equal(response.headers["referrer-policy"], "no-referrer");
});

test("hosted health reads keep request-local bindings and reject obsolete responses after recovery", async () => {
  const c = loadHostedReviewEnvironment(environment()),
    delayed = deferred();
  let requests = 0;
  const binding = (health) => ({
    receiver: { health },
    db: {
      collection: () => ({
        findOne: async () => ({ mode: "cedar", streamId: c.streamId }),
      }),
    },
  });
  const old = binding(async () => {
      await delayed.promise;
      return "old";
    }),
    current = binding(async () => "connected");
  const { app } = createHostedReviewApp({
    config: c,
    runtime: {
      ready: async () => (requests++ === 0 ? old : current),
      isCurrent: (value) => value === current || requests < 2,
    },
    sourceReader: () => "synthetic",
  });
  const first = invoke(app);
  await new Promise((r) => setImmediate(r));
  const second = await invoke(app);
  delayed.resolve();
  assert.equal(second.body.database, "connected");
  assert.equal((await first).status, 503);
});

test("hosted startup outage closes its failed pool and retry uses a new verified binding", async () => {
  const a = fake(),
    b = fake();
  a.connect = async () => {
    a.calls.connect++;
    throw new Error("dummy credential detail must not escape");
  };
  let attempts = 0;
  const runtime = createHostedReviewRuntime({
    config: loadHostedReviewEnvironment(environment()),
    makeClient: () => (attempts++ ? b : a),
    bind: async () => ({ ready: true }),
  });
  await assert.rejects(
    runtime.ready(),
    (error) =>
      !error.message.includes("dummy") && /unavailable/.test(error.message),
  );
  assert.equal(a.calls.close, 1);
  assert.deepEqual(await runtime.ready(), { ready: true });
  assert.equal(b.calls.connect, 1);
  await runtime.close();
});

test("client-construction failure is sanitized and closing queued initialization never constructs a pool", async () => {
  let calls = 0;
  const runtime = createHostedReviewRuntime({
    config: loadHostedReviewEnvironment(environment()),
    makeClient: () => {
      calls++;
      throw Error("dummy URI must not escape");
    },
  });
  await assert.rejects(
    runtime.ready(),
    (e) => !e.message.includes("dummy") && /unavailable/.test(e.message),
  );
  assert.equal(calls, 1);
  const queued = runtime.ready();
  await runtime.close();
  await assert.rejects(queued, /unavailable/);
  assert.equal(calls, 1);
});

test("Render source adapter is explicit, rejects malformed hosts/headers and ignores injected prefixes", () => {
  const c = config();
  assert.throws(() => createRenderReviewSource({}, c));
  const source = createRenderReviewSource(
    { CEDAR_REVIEW_TRUSTED_PROXY: "render-last-hop" },
    c,
  );
  const request = (forwarded, host = new URL(c.apiOrigin).host) => ({
    get: (name) => (name === "Host" ? host : forwarded),
  });
  assert.equal(source(request("198.51.100.9, 203.0.113.2")), "203.0.113.2");
  assert.equal(
    source(request("arbitrary user prefix, 2001:db8::2")),
    "2001:db8::2",
  );
  for (const forwarded of [
    undefined,
    "",
    "203.0.113.2, not-an-ip",
    "x".repeat(1025),
    "203.0.113.2\r\nspoof",
    Array(18).fill("203.0.113.2").join(","),
  ])
    assert.throws(() => source(request(forwarded)));
  assert.throws(() =>
    source(request("203.0.113.2", "unexpected.onrender.com")),
  );
});

test("Render entry uses explicit PORT and closes only its owned server/application once", async () => {
  const env = {
    ...environment(),
    CEDAR_REVIEW_TRUSTED_PROXY: "render-last-hop",
    PORT: "10000",
  };
  let closed = 0,
    connections = 0;
  const fakeServer = new EventEmitter();
  fakeServer.closeIdleConnections = () => connections++;
  fakeServer.close = (done) => {
    closed++;
    done?.();
  };
  let appClosed = 0;
  const service = await startHostedReviewServer({
    environment: env,
    createApplication: () => ({ app: "owned", close: async () => appClosed++ }),
    listen: (app, port) => {
      assert.equal(app, "owned");
      assert.equal(port, 10000);
      process.nextTick(() => fakeServer.emit("listening"));
      return fakeServer;
    },
  });
  await Promise.all([service.stop(), service.stop()]);
  assert.equal(closed, 1);
  assert.equal(appClosed, 1);
  assert.equal(connections, 1);
  await assert.rejects(
    startHostedReviewServer({ environment: { ...env, PORT: "65536" } }),
    /PORT/,
  );
});
