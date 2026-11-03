import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import {
  checkLauncherFiles,
  mongoRuntimeDirectories,
  projectRoot,
} from "../scripts/launcher/configuration.js";

const runtime =
  "C:\\Users\\Synthetic\\AppData\\Local\\Packages\\Example.App\\LocalCache\\Local\\CapstoneStaffDev";
const config = {
  runtimeDirectory: runtime,
  nodePath: "C:\\Node\\node.exe",
  appPath: join(
    projectRoot,
    "apps",
    "staff",
    "release",
    "synthetic",
    "Cedar Staff Development.exe",
  ),
};

test("physical MSIX runtime recognizes only its same-user LocalAppData process spelling", () => {
  assert.deepEqual(mongoRuntimeDirectories(runtime), [
    runtime,
    "C:\\Users\\Synthetic\\AppData\\Local\\CapstoneStaffDev",
  ]);
  for (const path of [
    "C:\\Other\\CapstoneStaffDev",
    "C:\\Users\\Synthetic\\AppData\\Local\\CapstoneStaffDev",
    runtime + "-other",
    runtime.replace("LocalCache", "Other"),
  ])
    assert.deepEqual(mongoRuntimeDirectories(path), [path]);
});

for (const code of ["ENOENT", "EACCES", "EPERM", "EBUSY", "ENOTDIR"]) {
  test(`readiness ${code} reports exact path/code, refuses startup and does not check past failure`, async () => {
    const calls = [],
      marker = join(runtime, "ready.json");
    await assert.rejects(
      checkLauncherFiles(config, {
        accessFile: async (path) => {
          calls.push(path);
          if (path === marker)
            throw Object.assign(
              Error("untrusted detail must not be displayed"),
              { code },
            );
        },
        resolvePath: async () => {
          throw Error("Must not continue after failed readiness check");
        },
      }),
      (error) => {
        assert.ok(error.message.includes(marker));
        assert.ok(error.message.includes(code));
        assert.equal(
          error.message.includes("missing its readiness marker"),
          code === "ENOENT",
        );
        assert.ok(!error.message.includes("untrusted detail"));
        return true;
      },
    );
    assert.equal(calls.at(-1), marker);
    assert.equal(calls.length, 4);
  });
}

test("all required files and package containment remain enforced", async () => {
  const calls = [];
  await checkLauncherFiles(config, {
    accessFile: async (path) => calls.push(path),
    resolvePath: async (path) => path,
  });
  assert.equal(calls.length, 7);
  assert.ok(calls.includes(join(runtime, "authority.dpapi")));
  assert.ok(calls.includes(join(runtime, "replica.key")));
  await assert.rejects(
    checkLauncherFiles(config, {
      accessFile: async () => {},
      resolvePath: async () => "C:\\Outside\\Cedar Staff Development.exe",
    }),
    /outside the approved package/,
  );
});
