import assert from "node:assert/strict";
import { test } from "node:test";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { controlOwnedHost } from "../scripts/launcher/runtime.js";
import {
  inspectListener,
  expectedListener,
} from "../scripts/launcher/windows.js";

const entry = fileURLToPath(
  new URL("./helpers/launcher-fixture-host.js", import.meta.url),
);
async function fixture() {
  const child = fork(entry, ["--synthetic-owned-fixture"], {
    windowsHide: true,
    execArgv: [],
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  const control = controlOwnedHost(child);
  const [message] = await once(child, "message");
  assert.equal(message.type, "fixture-ready");
  assert.ok(
    Number.isInteger(message.port) &&
      ![4100, 4101, 27018, 27017].includes(message.port),
  );
  return {
    child,
    control,
    url: `http://127.0.0.1:${message.port}`,
    port: message.port,
  };
}
test("real captured child cleans up before handoff; reused listener is untouched", async () => {
  const owned = await fixture();
  const reused = await fixture();
  try {
    assert.equal((await fetch(owned.url)).status, 200);
    await owned.control.stop();
    await assert.rejects(
      fetch(owned.url, { signal: AbortSignal.timeout(1000) }),
    );
    assert.equal((await fetch(reused.url)).status, 200);
    await owned.control.stop();
  } finally {
    await owned.control.stop();
    await reused.control.stop();
  }
});
test("prepared handoff remains reversible until disconnect; successful detach preserves service", async () => {
  const first = await fixture();
  try {
    await first.control.prepareRelease();
    await first.control.stop();
  } finally {
    await first.control.stop();
  }
  const second = await fixture();
  const closed = once(second.child, "exit");
  await second.control.prepareRelease();
  await second.control.commitRelease();
  second.control.detach();
  // The observer, unlike the launcher, must stay alive to assert fixture exit.
  second.child.ref();
  try {
    assert.equal((await fetch(second.url)).status, 200);
    await fetch(`${second.url}/finish-owned-test`);
    await closed;
  } finally {
    // After detach, teardown is the fixture's own narrowly scoped test endpoint,
    // not production HTTP, a stale PID, or a shared staff service.
    try {
      await fetch(`${second.url}/finish-owned-test`);
    } catch {}
  }
});
test("Windows port inspection reads an owned ephemeral listener and refuses it as staff API", async () => {
  const value = await fixture();
  try {
    const rows = await inspectListener(value.port);
    assert.equal(rows[0].pid, value.child.pid);
    assert.equal(
      expectedListener(rows, {
        executable: process.execPath,
        entry,
        arguments: ["--synthetic-owned-fixture"],
      }),
      "waiting",
    );
    assert.equal(
      expectedListener(rows, {
        executable: process.execPath,
        entry: "apps/staff-api/src/server.js",
        arguments: ["--demo-loopback"],
      }),
      "unexpected",
    );
  } finally {
    await value.control.stop();
  }
});

test("losing the parent after preparation but before explicit handoff cleans the owned child", async () => {
  const value = await fixture();
  const exited = once(value.child, "exit");
  await value.control.prepareRelease();
  value.child.disconnect();
  let timer;
  try {
    await Promise.race([
      exited,
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error("Pre-commit parent loss left its service running."),
            ),
          1500,
        );
      }),
    ]);
  } catch (error) {
    try {
      await fetch(`${value.url}/finish-owned-test`);
    } catch {}
    await exited;
    throw error;
  } finally {
    clearTimeout(timer);
  }
  await assert.rejects(fetch(value.url, { signal: AbortSignal.timeout(1000) }));
});
