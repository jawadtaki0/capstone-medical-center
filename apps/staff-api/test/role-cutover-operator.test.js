import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseNormalRoleArguments,
  assertStaffPortIdle,
  cutoverPlanDigest,
  assertPrivateArtifactRoot,
  privateArtifactFile,
  safeCutoverFailure,
} from "../scripts/normal-role-cutover.js";
const base = [
  "--normal-local",
  "--demo-loopback",
  "--action",
  "dry-run",
  "--mappings",
  "private.json",
  "--plan",
  "plan.json",
  "--app",
  "review.exe",
];
test("operator requires explicit mode/paths and exact per-action maintenance confirmation", () => {
  assert.equal(parseNormalRoleArguments(base)["--action"], "dry-run");
  for (const args of [
    [],
    base.filter((x) => x !== "--normal-local"),
    [...base, "--normal-local"],
    [...base, "--test-only"],
    [...base, "--action", "apply"],
  ])
    assert.throws(() => parseNormalRoleArguments(args));
  const apply = base
    .map((x) => (x === "dry-run" ? "apply" : x))
    .concat([
      "--digest",
      "a".repeat(64),
      "--backup",
      "private.dpapi",
      "--backup-digest",
      "b".repeat(64),
    ]);
  assert.throws(() => parseNormalRoleArguments(apply), /Acknowledge/);
  assert.throws(
    () =>
      parseNormalRoleArguments([...apply, "--acknowledge-maintenance-cutover"]),
    /confirmation/,
  );
  assert.equal(
    parseNormalRoleArguments([
      ...apply,
      "--acknowledge-maintenance-cutover",
      "--confirm",
      "APPLY REVIEWED ROLE CUTOVER",
    ])["--action"],
    "apply",
  );
});
test("known active service refuses maintenance without stopping the owned listener", async () => {
  const server = createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  try {
    await assert.rejects(assertStaffPortIdle(port), /occupied/);
    assert.equal(server.listening, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  await assertStaffPortIdle(port);
});
test("review digest binds runtime, package, operator, mapping and plan fields", () => {
  const document = {
    context: { runtimeFingerprint: "dummy" },
    packageIdentity: { archive: "dummy" },
    operator: [["module", "hash"]],
    mappings: { synthetic: { roles: ["Admin"] } },
    plan: { snapshotDigest: "dummy" },
  };
  const before = cutoverPlanDigest(document);
  for (const key of Object.keys(document))
    assert.notEqual(
      cutoverPlanDigest({ ...document, [key]: { changed: true } }),
      before,
    );
});
test("safe failure messages distinguish unavailable database and missing files without echoing private errors", () => {
  const secret = "DUMMY_PRIVATE_VALUE_NEVER_ECHO";
  for (const properties of [
    { name: "MongoServerSelectionError" },
    { code: "ENOENT" },
    { code: "EEXIST" },
    {},
  ]) {
    const error = Object.assign(Error(secret), properties);
    assert.equal(safeCutoverFailure(error).includes(secret), false);
  }
  assert.match(
    safeCutoverFailure({ name: "MongoServerSelectionError" }),
    /MongoDB is unavailable/,
  );
  assert.match(
    safeCutoverFailure({ code: "EEXIST" }),
    /nothing was overwritten/,
  );
  try {
    parseNormalRoleArguments([]);
  } catch (error) {
    assert.match(safeCutoverFailure(error), /explicit normal-local/);
  }
});
test("private artifacts reject traversal, redirected roots and existing-file overwrite", async () => {
  const project = await mkdtemp(join(tmpdir(), "cedar-role-paths-"));
  const outside = await mkdtemp(join(tmpdir(), "cedar-role-outside-"));
  try {
    const local = join(project, ".local"),
      base = join(local, "role-cutover");
    await mkdir(local);
    await assertPrivateArtifactRoot(project, base);
    const target = await privateArtifactFile(
      base,
      join(base, "plan.json"),
      true,
    );
    await writeFile(target, "dummy", { flag: "wx" });
    await assert.rejects(writeFile(target, "replace", { flag: "wx" }), {
      code: "EEXIST",
    });
    await assert.rejects(
      privateArtifactFile(base, join(outside, "plan.json"), true),
    );
    await symlink(outside, join(base, "outside"), "junction");
    await assert.rejects(
      privateArtifactFile(base, join(base, "outside", "plan.json"), true),
    );
    await rm(base, { recursive: true });
    await symlink(outside, base, "junction");
    await assert.rejects(
      assertPrivateArtifactRoot(project, base),
      /redirected/,
    );
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
