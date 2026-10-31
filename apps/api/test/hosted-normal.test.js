import test from "node:test";
import assert from "node:assert/strict";
import { loadHostedNormalEnvironment } from "../src/hosted-normal.js";
import {
  validateHostedNormalConfig,
  hostedNormalIdentity,
} from "../../../shared/hosted-normal-config.mjs";
import { assertPublicationStorage } from "../../../shared/publication-environment.mjs";
import { validateReceiverTarget } from "../../staff-api/src/publication-delivery.js";
import { createRequestTransport } from "../../staff-api/src/request-integration.js";

const c = () => ({
  mode: "normal-hosted",
  capstoneDemo: true,
  apiOrigin: "https://cedar-cmc-api.onrender.com",
  publicBase: "https://cedar-cmc.vercel.app",
  publicDatabase: "medical-center-dev",
  publicSrvHost: "synthetic.example.mongodb.net",
  streamId: "stream:00000000-0000-4000-8000-000000000001",
});
const environment = () => ({
  CEDAR_NORMAL_CAPSTONE_DEMO: "true",
  CEDAR_NORMAL_API_ORIGIN: c().apiOrigin,
  CEDAR_NORMAL_PUBLIC_ORIGIN: c().publicBase,
  CEDAR_NORMAL_DATABASE: c().publicDatabase,
  CEDAR_NORMAL_ATLAS_SRV_HOST: c().publicSrvHost,
  CEDAR_NORMAL_STREAM_ID: c().streamId,
  CEDAR_NORMAL_PUBLICATION_TOKEN: "a".repeat(43),
  CEDAR_NORMAL_REQUEST_CREDENTIAL: "b".repeat(43),
  CEDAR_NORMAL_REQUEST_KEY: "c".repeat(43),
  CEDAR_NORMAL_MONGODB_URI:
    "mongodb+srv://dummy:dummy@synthetic.example.mongodb.net/medical-center-dev?tls=true",
  CEDAR_NORMAL_CENTER_CONTACT: "Synthetic contact — capstone only",
});

test("normal hosted configuration is explicit and cannot select review, TEST, HTTP or weakened TLS", () => {
  const valid = loadHostedNormalEnvironment(environment());
  assert.equal(valid.publicDatabase, "medical-center-dev");
  assert.equal(hostedNormalIdentity(valid), hostedNormalIdentity(c()));
  for (const [key, value] of [
    ["publicDatabase", "capstone_public_review"],
    ["publicDatabase", "capstone_staff_test"],
    ["capstoneDemo", false],
    ["apiOrigin", "http://127.0.0.1:4000"],
    ["apiOrigin", c().apiOrigin + "/path"],
    ["publicBase", c().publicBase + "?x=1"],
  ])
    assert.throws(() => validateHostedNormalConfig({ ...c(), [key]: value }));
  for (const suffix of [
    "&tlsAllowInvalidCertificates=true",
    "&tlsInsecure=true",
    "&tlsAllowInvalidHostnames=true",
  ])
    assert.throws(() =>
      loadHostedNormalEnvironment({
        ...environment(),
        CEDAR_NORMAL_MONGODB_URI:
          environment().CEDAR_NORMAL_MONGODB_URI + suffix,
      }),
    );
  assert.throws(() =>
    loadHostedNormalEnvironment({
      ...environment(),
      CEDAR_NORMAL_REQUEST_CREDENTIAL: "a".repeat(43),
    }),
  );
});
test("normal hosted storage cannot authorize synthetic staff or a different Atlas database", () => {
  const client = { options: { srvHost: c().publicSrvHost, tls: true } };
  assertPublicationStorage(
    { databaseName: "medical-center-dev" },
    client,
    true,
    "public",
    c(),
  );
  assert.throws(() =>
    assertPublicationStorage(
      { databaseName: "capstone_public_review" },
      client,
      true,
      "public",
      c(),
    ),
  );
  assert.throws(() =>
    assertPublicationStorage(
      { databaseName: "medical-center-dev" },
      { options: { ...client.options, tlsAllowInvalidCertificates: true } },
      true,
      "public",
      c(),
    ),
  );
  assert.throws(() =>
    assertPublicationStorage(
      { databaseName: "capstone_staff_test" },
      {
        options: {
          hosts: [{ host: "127.0.0.1", port: 27018 }],
          replicaSet: "capstoneStaffDev",
        },
      },
      true,
      "staff",
      c(),
    ),
  );
});
test("normal transports bind fixed HTTPS paths, prohibit credential forwarding redirects, and retain explicit failure", async () => {
  assert.equal(
    validateReceiverTarget(c().apiOrigin + "/api/publications", true, c()),
    c().apiOrigin + "/api/publications",
  );
  assert.throws(() =>
    validateReceiverTarget(
      "https://other.onrender.com/api/publications",
      true,
      c(),
    ),
  );
  let calls = 0;
  const transport = createRequestTransport(
    {
      ...c(),
      target: c().apiOrigin + "/api/requests/integration",
      credential: "d".repeat(43),
    },
    async (url, options) => {
      calls++;
      assert.equal(url, c().apiOrigin + "/api/requests/integration/pull");
      assert.equal(options.redirect, "error");
      assert.equal(options.method, "POST");
      return new Response(JSON.stringify({ cursor: 0, requests: [] }));
    },
  );
  assert.deepEqual(await transport.pull(0), { cursor: 0, requests: [] });
  assert.equal(calls, 1);
  assert.throws(() =>
    createRequestTransport({
      ...c(),
      target: "https://other.onrender.com/api/requests/integration",
      credential: "d".repeat(43),
    }),
  );
});
