import { MongoClient } from "mongodb";
import { isIP } from "node:net";
import { createHostedRuntime, createHostedApp } from "./hosted-review.js";
import { createPublicationReceiver } from "./publication-receiver.js";
import { createPublicIntake } from "./website-requests.js";
import { validateHostedNormalConfig } from "../../../shared/hosted-normal-config.mjs";

export function loadHostedNormalEnvironment(e = process.env) {
  const c = validateHostedNormalConfig({
    mode: "normal-hosted",
    capstoneDemo: e.CEDAR_NORMAL_CAPSTONE_DEMO === "true",
    apiOrigin: e.CEDAR_NORMAL_API_ORIGIN,
    publicBase: e.CEDAR_NORMAL_PUBLIC_ORIGIN,
    publicDatabase: e.CEDAR_NORMAL_DATABASE,
    publicSrvHost: e.CEDAR_NORMAL_ATLAS_SRV_HOST,
    streamId: e.CEDAR_NORMAL_STREAM_ID,
  });
  const token = e.CEDAR_NORMAL_PUBLICATION_TOKEN,
    credential = e.CEDAR_NORMAL_REQUEST_CREDENTIAL,
    key = e.CEDAR_NORMAL_REQUEST_KEY,
    uri = e.CEDAR_NORMAL_MONGODB_URI;
  if (
    ![token, credential, key].every(
      (v) => typeof v === "string" && /^[A-Za-z0-9_-]{43}$/.test(v),
    ) ||
    new Set([token, credential, key]).size !== 3 ||
    typeof e.CEDAR_NORMAL_CENTER_CONTACT !== "string" ||
    !e.CEDAR_NORMAL_CENTER_CONTACT.trim() ||
    e.CEDAR_NORMAL_CENTER_CONTACT.length > 120
  )
    throw Error("Dedicated normal hosted secrets required.");
  let u;
  try {
    u = new URL(uri);
  } catch {
    throw Error("Invalid protected Atlas target.");
  }
  if (
    u.protocol !== "mongodb+srv:" ||
    u.hostname !== c.publicSrvHost ||
    !u.username ||
    !u.password ||
    u.port ||
    u.hash ||
    !["", "/", "/medical-center-dev"].includes(u.pathname)
  )
    throw Error("Invalid protected Atlas target.");
  for (const [name, value] of u.searchParams) {
    const k = name.toLowerCase(),
      v = value.toLowerCase();
    if (
      (["tls", "ssl"].includes(k) && v !== "true") ||
      ([
        "tlsinsecure",
        "tlsallowinvalidcertificates",
        "tlsallowinvalidhostnames",
      ].includes(k) &&
        v !== "false")
    )
      throw Error("Strict TLS is required.");
  }
  return {
    ...c,
    uri,
    publicationToken: token,
    requestCredential: credential,
    key: Buffer.from(key, "base64url"),
    contact: e.CEDAR_NORMAL_CENTER_CONTACT.trim(),
  };
}

export function createNormalSource(e, c) {
  if (e.CEDAR_NORMAL_TRUSTED_PROXY !== "render-cloudflare-client")
    throw Error("Explicit Render source policy required.");
  return (request) => {
    const ip = request.get("CF-Connecting-IP");
    if (
      request.get("Host") !== new URL(c.apiOrigin).host ||
      typeof ip !== "string" ||
      ip !== ip.trim() ||
      !isIP(ip)
    )
      throw Error("Hosted source unavailable.");
    return ip.toLowerCase();
  };
}

export function createHostedNormalApplication({
  config,
  sourceReader,
  makeClient,
} = {}) {
  validateHostedNormalConfig(config);
  const runtime = createHostedRuntime({
    config,
    validateConfig: validateHostedNormalConfig,
    makeClient:
      makeClient ??
      (() =>
        new MongoClient(config.uri, {
          tls: true,
          tlsAllowInvalidCertificates: false,
          tlsAllowInvalidHostnames: false,
          maxPoolSize: 5,
          minPoolSize: 0,
          maxConnecting: 2,
          maxIdleTimeMS: 30000,
          serverSelectionTimeoutMS: 5000,
          connectTimeoutMS: 5000,
          socketTimeoutMS: 10000,
          timeoutMS: 10000,
          appName: "cedar-public-capstone",
        })),
    bind: async ({ db, client }) => {
      const receiver = await createPublicationReceiver({
        db,
        client,
        token: config.publicationToken,
        streamId: config.streamId,
        demoMode: true,
        environment: config,
      });
      const intake = createPublicIntake({
        db,
        client,
        key: config.key,
        localReviewOnly: false,
        sessionReader: (date) => receiver.requestSessions(date),
        professionalReader: (date) => receiver.requestProfessionals(date),
        upcomingReader: (input) => receiver.requestUpcoming(input),
      });
      return { db, receiver, intake };
    },
  });
  return createHostedApp({
    config,
    runtime,
    sourceReader,
    validateConfig: validateHostedNormalConfig,
    failureMessage:
      "The capstone server may be waking or temporarily unavailable. Please retry; no booking is confirmed.",
  });
}
