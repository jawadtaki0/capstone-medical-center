import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { dpapi, runtimeDirectory } from "./local-security.js";
import { validateHostedNormalConfig } from "../../../shared/hosted-normal-config.mjs";

export function validateNormalConnection(c) {
  validateHostedNormalConfig(c);
  const allowed = [
    "version",
    "mode",
    "capstoneDemo",
    "apiOrigin",
    "publicBase",
    "publicDatabase",
    "publicSrvHost",
    "streamId",
    "importDigest",
    "token",
    "credential",
    "key",
    "contact",
  ];
  if (
    c.version !== 1 ||
    Object.keys(c).length !== allowed.length ||
    Object.keys(c).some((k) => !allowed.includes(k)) ||
    !/^[a-f0-9]{64}$/.test(c.importDigest ?? "") ||
    typeof c.contact !== "string" ||
    !c.contact.trim() ||
    c.contact.length > 120 ||
    ![c.token, c.credential, c.key].every(
      (v) => typeof v === "string" && /^[A-Za-z0-9_-]{43}$/.test(v),
    ) ||
    new Set([c.token, c.credential, c.key]).size !== 3
  )
    throw Error("Normal hosted connection requires operator reconciliation.");
  return c;
}

export async function loadNormalConnection({
  directory = runtimeDirectory,
  unwrap = dpapi,
} = {}) {
  let bytes;
  try {
    bytes = await readFile(join(directory, "hosted-normal.dpapi"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw Error("Normal hosted connection unavailable.");
  }
  const plain = await unwrap(bytes, "Unprotect");
  try {
    return validateNormalConnection(JSON.parse(plain.toString()));
  } finally {
    plain.fill(0);
  }
}
