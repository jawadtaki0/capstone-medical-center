import express from "express";
import { AsyncLocalStorage } from "node:async_hooks";
import { MongoClient } from "mongodb";
import { createApp } from "./app.js";
import { createPublicationReceiver } from "./publication-receiver.js";
import { createPublicIntake } from "./website-requests.js";
import { validateHostedReviewConfig } from "../../../shared/hosted-review-config.mjs";

const unavailable = () =>
  new Error("Hosted review is temporarily unavailable.");
const secret = (value) =>
  typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);

// Only dedicated deployment environment values are read. Never imports Windows
// protection helpers or falls back to normal/local credentials.
export function loadHostedReviewEnvironment(environment = process.env) {
  const c = validateHostedReviewConfig({
    mode: "hosted-review",
    apiOrigin: environment.CEDAR_REVIEW_API_ORIGIN,
    publicBase: environment.CEDAR_REVIEW_PUBLIC_ORIGIN,
    publicDatabase: environment.CEDAR_REVIEW_DATABASE,
    publicSrvHost: environment.CEDAR_REVIEW_ATLAS_SRV_HOST,
    streamId: environment.CEDAR_REVIEW_STREAM_ID,
  });
  const publicationToken = environment.CEDAR_REVIEW_PUBLICATION_TOKEN,
    requestCredential = environment.CEDAR_REVIEW_REQUEST_CREDENTIAL,
    keyValue = environment.CEDAR_REVIEW_REQUEST_KEY,
    contact = environment.CEDAR_REVIEW_CENTER_CONTACT,
    uri = environment.CEDAR_REVIEW_MONGODB_URI;
  if (
    ![publicationToken, requestCredential, keyValue].every(secret) ||
    new Set([publicationToken, requestCredential, keyValue]).size !== 3 ||
    typeof contact !== "string" ||
    !contact.trim() ||
    contact.length > 120 ||
    typeof uri !== "string"
  )
    throw unavailable();
  try {
    const u = new URL(uri);
    if (
      u.protocol !== "mongodb+srv:" ||
      u.hostname !== c.publicSrvHost ||
      u.port ||
      u.hash ||
      !u.username ||
      !u.password ||
      !["", "/", "/capstone_public_review"].includes(u.pathname)
    )
      throw unavailable();
    for (const [name, value] of u.searchParams) {
      const n = name.toLowerCase(),
        v = value.toLowerCase();
      if (
        (["tls", "ssl"].includes(n) && v !== "true") ||
        ([
          "tlsinsecure",
          "tlsallowinvalidcertificates",
          "tlsallowinvalidhostnames",
        ].includes(n) &&
          v !== "false")
      )
        throw unavailable();
    }
  } catch {
    throw unavailable();
  }
  return {
    ...c,
    uri,
    publicationToken,
    requestCredential,
    key: Buffer.from(keyValue, "base64url"),
    contact: contact.trim(),
    environment: {
      ...c,
      publicTarget: { database: c.publicDatabase, srvHost: c.publicSrvHost },
    },
  };
}

async function bindHostedReview({ db, client, config }) {
  const receiver = await createPublicationReceiver({
    db,
    client,
    token: config.publicationToken,
    streamId: config.streamId,
    demoMode: true,
    environment: config.environment,
  });
  const intake = createPublicIntake({
    db,
    client,
    key: config.key,
    localReviewOnly: false,
    sessionReader: (date) => receiver.requestSessions(date),
    professionalReader: (date) => receiver.requestProfessionals(date),
  });
  return { receiver, intake, db };
}

// Render remains request-driven even if it suspends the free instance. One
// pool/initialization per process, no readiness timer or after-response work.
export function createHostedReviewRuntime({
  config,
  makeClient = () =>
    new MongoClient(config.uri, {
      tls: true,
      tlsInsecure: false,
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
      appName: "cedar-public-review",
    }),
  bind = bindHostedReview,
} = {}) {
  validateHostedReviewConfig(config);
  let client,
    pending,
    binding,
    generation = 0;
  async function invalidate() {
    const prior = client;
    generation++;
    client = pending = binding = undefined;
    await prior?.close().catch(() => {});
  }
  function ready() {
    if (pending) return pending;
    const version = generation;
    let candidate;
    const attempt = Promise.resolve()
      .then(async () => {
        if (version !== generation) throw unavailable();
        candidate = client ?? makeClient();
        client = candidate;
        await candidate.connect();
        const db = candidate.db(config.publicDatabase);
        await db.command({ ping: 1 }, { maxTimeMS: 3000 });
        if (version !== generation || candidate !== client) throw unavailable();
        const next = binding ?? (await bind({ db, client: candidate, config }));
        if (version !== generation || candidate !== client) throw unavailable();
        binding = next;
        return next;
      })
      .catch(async () => {
        if (version === generation && (!candidate || candidate === client))
          await invalidate();
        throw unavailable();
      })
      .finally(() => {
        if (pending === attempt) pending = undefined;
      });
    pending = attempt;
    return attempt;
  }
  return {
    ready,
    invalidate,
    close: invalidate,
    isCurrent: (value) => binding === value && Boolean(client),
  };
}

export function createHostedReviewApp({
  config,
  runtime = createHostedReviewRuntime({ config }),
  sourceReader,
} = {}) {
  validateHostedReviewConfig(config);
  if (typeof sourceReader !== "function")
    throw new Error("An explicit hosting-platform source adapter is required.");
  const context = new AsyncLocalStorage();
  const current = () => context.getStore();
  const assertCurrent = (binding) => {
    if (runtime.isCurrent && !runtime.isCurrent(binding)) throw unavailable();
  };
  const call = async (group, key, args) => {
    const binding = current();
    assertCurrent(binding);
    const result = await binding[group][key](...args);
    assertCurrent(binding);
    return result;
  };
  const receiver = Object.fromEntries(
    ["accept", "health", "schedule", "professionals"].map((key) => [
      key,
      (...args) => call("receiver", key, args),
    ]),
  );
  receiver.authorized = (...args) => {
    const binding = current();
    assertCurrent(binding);
    return binding.receiver.authorized(...args);
  };
  const service = Object.fromEntries(
    [
      "professionals",
      "sessions",
      "submit",
      "track",
      "pull",
      "accept",
      "rotate",
    ].map((key) => [key, (...args) => call("intake", key, args)]),
  );
  const inner = createApp({
    clientOrigin: config.publicBase,
    publicationReceiver: receiver,
    publicAuthority: {
      mode: async () => {
        const authority = await current()
          .db.collection("public_data_authority")
          .findOne({ _id: "source" });
        assertCurrent(current());
        if (
          authority?.mode !== "cedar" ||
          authority.streamId !== config.streamId
        )
          throw unavailable();
        return "cedar";
      },
    },
    scheduleReader: async () => {
      throw unavailable();
    },
    professionalsReader: async () => {
      throw unavailable();
    },
    websiteRequests: {
      service,
      credential: config.requestCredential,
      sourceReader,
    },
  });
  const app = express();
  app.disable("x-powered-by");
  app.use(async (_request, response, next) => {
    response.set({
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex, nofollow",
    });
    try {
      const binding = await runtime.ready();
      context.run(binding, next);
    } catch {
      response.status(503).json({
        error: "review_unavailable",
        message:
          "The synthetic review service is temporarily unavailable. Please retry; no booking is confirmed.",
      });
    }
  });
  app.use(inner);
  app.use((_error, _request, response, next) => {
    if (response.headersSent) return next(_error);
    response.status(503).json({
      error: "review_unavailable",
      message:
        "The synthetic review service is temporarily unavailable. Please retry; no booking is confirmed.",
    });
  });
  return { app, close: () => runtime.close() };
}
