import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { dpapi, protectDirectory, runtimeDirectory } from "./local-security.js";
import { secret } from "../../../shared/website-request-contract.mjs";
import { validateHostedReviewConfig } from "../../../shared/hosted-review-config.mjs";

function validateRequestLimits(c) {
  for (const [k, v] of Object.entries(c.limits ?? {}))
    if (
      ![
        "submitMinute",
        "submitHour",
        "trackingSource",
        "trackingToken",
      ].includes(k) ||
      !Number.isSafeInteger(v) ||
      v < 1
    )
      throw Error("Invalid request limit configuration.");
  for (const k of ["rotationMinute", "rotationDay"])
    if (c[k] !== undefined && (!Number.isSafeInteger(c[k]) || c[k] < 1))
      throw Error("Invalid replacement limit configuration.");
}
export function validateRequestConfig(c) {
  if (
    c?.version !== 1 ||
    c.mode !== "normal-local" ||
    c.target !== "http://127.0.0.1:4000/api/requests/integration" ||
    !["http://localhost:5173", "http://127.0.0.1:4000"].includes(
      c.publicBase,
    ) ||
    typeof c.contact !== "string" ||
    !c.contact.trim() ||
    c.contact.length > 120
  )
    throw Error("Request integration configuration requires operator review.");
  validateRequestLimits(c);
  secret(c.credential);
  secret(c.key);
  return c;
}
export async function loadRequestConfig({
  directory = runtimeDirectory,
  unwrap = dpapi,
} = {}) {
  let bytes;
  try {
    bytes = await readFile(join(directory, "website-requests.dpapi"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw Error("Request configuration unavailable.");
  }
  const plain = await unwrap(bytes, "Unprotect");
  try {
    const c = validateRequestConfig(JSON.parse(plain.toString()));
    return { ...c, key: Buffer.from(c.key, "base64url") };
  } finally {
    plain.fill(0);
  }
}
export async function provisionRequestConfig({
  contact,
  publicBase,
  directory = runtimeDirectory,
  confirmed = false,
  wrap = dpapi,
  protect = protectDirectory,
} = {}) {
  if (!confirmed)
    throw Error(
      "Explicit private request integration provisioning approval is required.",
    );
  const c = validateRequestConfig({
    version: 1,
    mode: "normal-local",
    target: "http://127.0.0.1:4000/api/requests/integration",
    publicBase,
    contact,
    credential: randomBytes(32).toString("base64url"),
    key: randomBytes(32).toString("base64url"),
  });
  await protect(directory);
  const plain = Buffer.from(JSON.stringify(c));
  try {
    await writeFile(
      join(directory, "website-requests.dpapi"),
      await wrap(plain, "Protect"),
      { flag: "wx", mode: 0o600 },
    );
  } finally {
    plain.fill(0);
  }
  return { configured: true };
}

export function validateHostedReviewRequestConfig(c) {
  validateHostedReviewConfig(c);
  const allowed = [
    "version",
    "mode",
    "apiOrigin",
    "publicBase",
    "publicDatabase",
    "publicSrvHost",
    "streamId",
    "target",
    "contact",
    "credential",
    "key",
    "manualRefreshOnly",
    "limits",
    "rotationMinute",
    "rotationDay",
  ];
  if (
    Object.keys(c).some((key) => !allowed.includes(key)) ||
    c.version !== 1 ||
    c.target !== `${c.apiOrigin}/api/requests/integration` ||
    c.manualRefreshOnly !== true ||
    typeof c.contact !== "string" ||
    !c.contact.trim() ||
    c.contact.length > 120 ||
    c.key === c.credential
  )
    throw Error("Explicit isolated review request configuration is required.");
  validateRequestLimits(c);
  secret(c.credential);
  secret(c.key);
  return c;
}
function reviewDirectory(directory) {
  if (
    typeof directory !== "string" ||
    !directory.trim() ||
    resolve(directory).toLowerCase() === resolve(runtimeDirectory).toLowerCase()
  )
    throw Error("Select a separate explicit review runtime directory.");
  return directory;
}
export async function loadHostedReviewRequestConfig({
  directory,
  unwrap = dpapi,
} = {}) {
  reviewDirectory(directory);
  let bytes;
  try {
    bytes = await readFile(
      join(directory, "website-requests-hosted-review.dpapi"),
    );
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw Error("Review request configuration unavailable.");
  }
  const plain = await unwrap(bytes, "Unprotect");
  try {
    const c = validateHostedReviewRequestConfig(JSON.parse(plain.toString()));
    return { ...c, key: Buffer.from(c.key, "base64url") };
  } finally {
    plain.fill(0);
  }
}
export async function provisionHostedReviewRequestConfig({
  config,
  directory,
  confirmed = false,
  wrap = dpapi,
  protect = protectDirectory,
} = {}) {
  if (!confirmed)
    throw Error("Explicit isolated review provisioning approval is required.");
  reviewDirectory(directory);
  validateHostedReviewRequestConfig(config);
  await protect(directory);
  const plain = Buffer.from(JSON.stringify(config));
  try {
    await writeFile(
      join(directory, "website-requests-hosted-review.dpapi"),
      await wrap(plain, "Protect"),
      { flag: "wx", mode: 0o600 },
    );
  } finally {
    plain.fill(0);
  }
  return { configured: true, mode: "hosted-review", manualRefreshOnly: true };
}
export function createRequestTransport(config, request = fetch) {
  const { target, credential, mode = "normal-local" } = config;
  const u = new URL(target);
  if (mode === "hosted-review") {
    validateHostedReviewConfig(config);
    if (target !== `${config.apiOrigin}/api/requests/integration`)
      throw Error(
        "The request destination must match the explicit review origin and fixed path.",
      );
  } else if (
    !["normal-local", "test"].includes(mode) ||
    u.protocol !== "http:" ||
    u.hostname !== "127.0.0.1" ||
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    u.pathname !== "/api/requests/integration" ||
    (mode !== "test" && u.port !== "4000")
  )
    throw Error(
      "Only the fixed explicit loopback request receiver is supported.",
    );
  secret(credential);
  const send = async (action, body, budget = {}) => {
    const timeout =
      mode === "hosted-review" ? (budget.remainingMs ?? 75000) : 5000;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 75000)
      throw Error("Request synchronization time budget is exhausted.");
    let response;
    try {
      response = await request(`${u.href}/${action}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${credential}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(timeout),
      });
    } catch {
      throw Error("Public request service unavailable.");
    }
    if (!response.ok)
      throw Object.assign(Error("Public request synchronization failed."), {
        status: response.status,
      });
    const reader = response.body.getReader();
    let length = 0;
    const chunks = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 512000) {
        await reader.cancel();
        throw Error("Request response exceeded bound.");
      }
      chunks.push(Buffer.from(value));
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw Error("Public request synchronization response was invalid.");
    }
  };
  return {
    pull: (cursor, budget) => send("pull", { cursor }, budget),
    event: (e, budget) => send("event", e, budget),
    rotate: (i, budget) => send("rotate", i, budget),
  };
}
export function startRequestWorker(
  service,
  { interval = 30000, onError = () => {}, automatic = true } = {},
) {
  let stopped = false,
    timer,
    busy;
  async function tick() {
    if (stopped) return;
    if (busy) return busy;
    busy = service
      .pump()
      .catch(() =>
        onError(
          "Website request synchronization unavailable; local bookings remain intact.",
        ),
      )
      .finally(() => {
        busy = null;
        if (!stopped && automatic) {
          timer = setTimeout(tick, interval);
          timer.unref?.();
        }
      });
    return busy;
  }
  if (automatic) void tick();
  return {
    runOnce: tick,
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await busy;
    },
  };
}
export function startHostedReviewRequestWorker(service, { onError } = {}) {
  // No startup pull or idle keep-alive. Authorized Refresh requests already
  // pumps durably; this helper permits explicit operator-driven recovery only.
  return startRequestWorker(service, { automatic: false, onError });
}
