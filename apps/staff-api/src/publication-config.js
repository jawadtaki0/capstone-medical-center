import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { dpapi, protectDirectory, runtimeDirectory } from "./local-security.js";

export function validatePublicationConfig(value) {
  const keys = [
    "version",
    "mode",
    "streamId",
    "token",
    "target",
    "publicDatabase",
    "publicSrvHost",
    "importDigest",
  ];
  if (
    !value ||
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some((k) => !keys.includes(k)) ||
    value.version !== 1 ||
    value.mode !== "normal-local" ||
    !/^stream:[a-f0-9-]{36}$/.test(value.streamId) ||
    !/^[A-Za-z0-9_-]{43}$/.test(value.token) ||
    value.target !== "http://127.0.0.1:4000/api/publications" ||
    value.publicDatabase !== "medical-center-dev" ||
    typeof value.publicSrvHost !== "string" ||
    !/^[a-z0-9.-]+\.mongodb\.net$/.test(value.publicSrvHost) ||
    !/^[a-f0-9]{64}$/.test(value.importDigest)
  )
    throw new Error(
      "Publication configuration is invalid. Review the private operator setup; no defaults or replacement credentials were used.",
    );
  return value;
}
export async function loadPublicationConfig({
  directory = runtimeDirectory,
  unwrap = dpapi,
} = {}) {
  let bytes;
  try {
    bytes = await readFile(join(directory, "publication.dpapi"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error("Publication configuration could not be read.");
  }
  const plain = await unwrap(bytes, "Unprotect");
  try {
    return validatePublicationConfig(JSON.parse(plain.toString("utf8")));
  } finally {
    plain.fill(0);
  }
}
export async function provisionPublicationConfig({
  publicSrvHost,
  importDigest,
  directory = runtimeDirectory,
  protect = protectDirectory,
  wrap = dpapi,
  confirmed = false,
}) {
  if (!confirmed)
    throw new Error(
      "Explicit private publication provisioning confirmation is required.",
    );
  const value = validatePublicationConfig({
    version: 1,
    mode: "normal-local",
    streamId: `stream:${randomUUID()}`,
    token: randomBytes(32).toString("base64url"),
    target: "http://127.0.0.1:4000/api/publications",
    publicDatabase: "medical-center-dev",
    publicSrvHost,
    importDigest,
  });
  await protect(directory);
  const plain = Buffer.from(JSON.stringify(value));
  let encrypted;
  try {
    encrypted = await wrap(plain, "Protect");
  } finally {
    plain.fill(0);
  }
  // No overwrite or rotation path. An existing config is an explicit reconciliation checkpoint.
  await writeFile(join(directory, "publication.dpapi"), encrypted, {
    flag: "wx",
    mode: 0o600,
  });
  return value;
}
export const publicationEnvironment = (config) => ({
  mode: "normal-local",
  publicTarget: {
    database: config.publicDatabase,
    srvHost: config.publicSrvHost,
  },
});
