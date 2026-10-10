import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import {
  acquireLauncherLock,
  expectedListener,
  quoteWindowsArgument,
  safeProcessOptions,
  applicationProcessOptions,
} from "../scripts/launcher/windows.js";
import {
  childEnvironment,
  validateLauncherConfig,
  projectRoot,
} from "../scripts/launcher/configuration.js";
import { join } from "node:path";

const executable = "C:\\Program Files\\nodejs\\node.exe";
const entry = "C:\\Project with spaces\\apps\\staff-api\\src\\server.js";
const expected = { executable, entry, arguments: ["--demo-loopback"] };
const row = {
  pid: 123,
  address: "127.0.0.1",
  executable,
  commandLine: `"${executable}" "${entry}" --demo-loopback`,
};

test("background workers hide consoles but the selected GUI application remains visible", () => {
  const runtime = "C:\\Private runtime";
  assert.equal(safeProcessOptions(runtime).windowsHide, true);
  const gui = applicationProcessOptions(runtime);
  assert.equal(gui.windowsHide, false);
  assert.equal(gui.detached, true);
  assert.equal(gui.shell, false);
  assert.equal(gui.stdio, "ignore");
  assert.equal(gui.env.CAPSTONE_STAFF_RUNTIME_DIR, runtime);
});

test("port recognition requires executable, exact entry, explicit demo and loopback", () => {
  assert.equal(expectedListener([], expected), "absent");
  assert.equal(expectedListener([row], expected), "waiting");
  for (const patch of [
    { address: "0.0.0.0" },
    { executable: "C:\\Other\\node.exe" },
    { commandLine: `node "${entry}.unexpected" --demo-loopback` },
    { commandLine: `node "${entry}" --demo-loopback-unrelated` },
    { commandLine: `node "${entry}" --demo-loopback --test-database` },
    { commandLine: "dummy credentials must never appear in diagnostics" },
  ])
    assert.equal(
      expectedListener([{ ...row, ...patch }], expected),
      "unexpected",
    );
  assert.equal(
    expectedListener([row, { ...row, pid: 124 }], expected),
    "unexpected",
  );
});
test("Windows shortcut argument quoting retains spaces and trailing slashes", () => {
  assert.equal(
    quoteWindowsArgument("C:\\path with spaces\\file.js"),
    '"C:\\path with spaces\\file.js"',
  );
  assert.equal(quoteWindowsArgument("C:\\ending\\"), '"C:\\ending\\\\"');
  assert.throws(() => quoteWindowsArgument("line\ncommand"));
});
test("child environment strips injected Node/TLS/demo/provider overrides", () => {
  const original = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = "--inspect=0.0.0.0";
  try {
    const value = childEnvironment("C:\\Private runtime");
    assert.equal(value.NODE_OPTIONS, undefined);
    assert.equal(value.CAPSTONE_STAFF_RUNTIME_DIR, "C:\\Private runtime");
    assert.equal(value.STAFF_API_URL, "http://127.0.0.1:4100");
    assert.equal(value.STAFF_SETUP_TEST_MEMORY, undefined);
  } finally {
    if (original === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = original;
  }
});
test("explicit package selection rejects remote paths, other executables and implicit HTTP", () => {
  const value = {
    version: 1,
    demoMode: true,
    runtimeDirectory: "C:\\Private runtime",
    nodePath: executable,
    appPath: join(
      projectRoot,
      "apps",
      "staff",
      "release",
      "review",
      "win-unpacked",
      "Cedar Staff Development.exe",
    ),
  };
  assert.equal(validateLauncherConfig(value).appPath, value.appPath);
  for (const patch of [
    { demoMode: false },
    { runtimeDirectory: "\\\\remote\\runtime" },
    { nodePath: "C:\\Other\\cmd.exe" },
    { appPath: "C:\\Other\\Cedar Staff Development.exe" },
  ])
    assert.throws(() => validateLauncherConfig({ ...value, ...patch }));
});
test("real Windows named-pipe lock serializes concurrent invocations and is reusable after owner closes", async () => {
  const key = `synthetic-launcher-${randomUUID()}`;
  const close = await acquireLauncherLock(key);
  try {
    await assert.rejects(acquireLauncherLock(key), /already in progress/);
  } finally {
    await close();
  }
  const second = await acquireLauncherLock(key);
  await second();
});
