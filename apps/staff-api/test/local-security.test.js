import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { join, normalize } from "node:path";
import { tmpdir } from "node:os";
import { validateTarget } from "../src/config.js";
import {
  createVault,
  dpapi,
  resolveRuntimeDirectory,
} from "../src/local-security.js";

test("runtime path retains the existing AppData and home defaults", () => {
  const syntheticHome = join(tmpdir(), "synthetic-staff-home");
  const syntheticLocal = join(syntheticHome, "synthetic-local");
  assert.equal(
    resolveRuntimeDirectory({ LOCALAPPDATA: syntheticLocal }, syntheticHome),
    join(syntheticLocal, "CapstoneStaffDev"),
  );
  assert.equal(
    resolveRuntimeDirectory({}, syntheticHome),
    join(syntheticHome, "AppData", "Local", "CapstoneStaffDev"),
  );
});

test("explicit runtime path wins without modifying the environment or accessing files", () => {
  const selected = join(tmpdir(), "synthetic-existing-staff-runtime");
  const environment = Object.freeze({
    LOCALAPPDATA: join(tmpdir(), "other-synthetic-location"),
    CAPSTONE_STAFF_RUNTIME_DIR: selected,
  });
  assert.equal(resolveRuntimeDirectory(environment), normalize(selected));
  assert.equal(environment.CAPSTONE_STAFF_RUNTIME_DIR, selected);
});

test("invalid explicit runtime paths fail closed rather than silently using another key store", () => {
  const selected = join(tmpdir(), "synthetic-existing-staff-runtime");
  for (const value of [
    "",
    ".",
    "relative/folder",
    "X:relative",
    "\\root-relative",
    "\\\\server\\share",
    ` ${selected}`,
    `${selected} `,
    `${selected}\0`,
    123,
    null,
  ]) {
    assert.throws(
      () => resolveRuntimeDirectory({ CAPSTONE_STAFF_RUNTIME_DIR: value }),
      /absolute local directory/,
    );
  }
  if (process.platform === "win32") {
    assert.throws(
      () =>
        resolveRuntimeDirectory({
          CAPSTONE_STAFF_RUNTIME_DIR: "C:\\synthetic-runtime:stream",
        }),
      /absolute local directory/,
    );
  }
});

test("database guard refuses public/Atlas/non-isolated targets", () => {
  const target = {
    host: "127.0.0.1",
    port: 27018,
    database: "capstone_staff_dev",
    replicaSet: "capstoneStaffDev",
  };
  validateTarget(target);
  for (const change of [
    { host: "cluster.mongodb.net" },
    { port: 27017 },
    { database: "medical_center" },
    { replicaSet: "other" },
  ])
    assert.throws(() => validateTarget({ ...target, ...change }));
});
test("authenticated MFA encryption rejects corruption/wrong key", () => {
  const vault = createVault(randomBytes(32).toString("base64"));
  const record = vault.encrypt("synthetic-only-factor");
  assert.equal(vault.decrypt(record), "synthetic-only-factor");
  assert.equal(JSON.stringify(record).includes("synthetic-only-factor"), false);
  assert.throws(() =>
    createVault(randomBytes(32).toString("base64")).decrypt(record),
  );
  assert.throws(() =>
    vault.decrypt({ ...record, tag: randomBytes(16).toString("base64") }),
  );
  vault.destroy();
});
test(
  "Windows DPAPI roundtrip uses no plaintext key file",
  { skip: process.platform !== "win32" },
  async () => {
    const privateValue = randomBytes(32);
    const wrapped = await dpapi(privateValue, "Protect");
    assert.notDeepEqual(wrapped, privateValue);
    assert.deepEqual(await dpapi(wrapped, "Unprotect"), privateValue);
  },
);
