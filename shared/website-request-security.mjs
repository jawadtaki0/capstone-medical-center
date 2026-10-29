import {
  createHash,
  createHmac,
  randomBytes,
  createCipheriv,
  createDecipheriv,
  timingSafeEqual,
} from "node:crypto";
import { requestFail } from "./website-request-contract.mjs";
const canonical = (value) =>
  value instanceof Date
    ? value.toISOString()
    : Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .filter((k) => value[k] !== undefined)
              .map((k) => [k, canonical(value[k])]),
          )
        : value;
export const digest = (value) =>
  createHash("sha256")
    .update(
      typeof value === "string" ? value : JSON.stringify(canonical(value)),
    )
    .digest("hex");
export const randomToken = () => randomBytes(32).toString("base64url");
export function requestCrypto(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32)
    throw Error("A dedicated request encryption key is required.");
  return {
    hash: digest,
    source: (value) =>
      createHmac("sha256", key).update(String(value)).digest("hex"),
    seal(value, context) {
      const iv = randomBytes(12),
        c = createCipheriv("aes-256-gcm", key, iv);
      c.setAAD(Buffer.from(context));
      const data = Buffer.concat([c.update(JSON.stringify(value)), c.final()]);
      return {
        iv: iv.toString("base64url"),
        data: data.toString("base64url"),
        tag: c.getAuthTag().toString("base64url"),
      };
    },
    open(value, context) {
      try {
        const c = createDecipheriv(
          "aes-256-gcm",
          key,
          Buffer.from(value.iv, "base64url"),
        );
        c.setAAD(Buffer.from(context));
        c.setAuthTag(Buffer.from(value.tag, "base64url"));
        return JSON.parse(
          Buffer.concat([
            c.update(Buffer.from(value.data, "base64url")),
            c.final(),
          ]).toString(),
        );
      } catch {
        throw requestFail(
          "request_unavailable",
          "This request is unavailable.",
          503,
        );
      }
    },
  };
}
export function integrationAuthorized(value, expected) {
  if (typeof value !== "string" || typeof expected !== "string") return false;
  const a = Buffer.from(value),
    b = Buffer.from(`Bearer ${expected}`);
  return a.length === b.length && timingSafeEqual(a, b);
}
export async function requestTransaction(client, action) {
  const s = client.startSession();
  try {
    return await s.withTransaction(() => action(s), {
      readConcern: { level: "snapshot" },
      writeConcern: { w: "majority" },
      readPreference: "primary",
    });
  } finally {
    await s.endSession();
  }
}
export async function consumeCounter(
  db,
  id,
  limit,
  windowMs,
  now,
  { session } = {},
) {
  const bucket = Math.floor(now.getTime() / windowMs),
    key = `${id}:${bucket}`;
  const row = await db.collection("website_request_counters").findOneAndUpdate(
    { _id: key },
    {
      $inc: { count: 1 },
      $setOnInsert: {
        expiresAt: new Date((bucket + 1) * windowMs + 48 * 3600000),
      },
    },
    { upsert: true, returnDocument: "after", session },
  );
  if (row.count > limit)
    throw requestFail(
      "request_rate_limited",
      "Too many requests. Please wait and try again.",
      429,
    );
}
