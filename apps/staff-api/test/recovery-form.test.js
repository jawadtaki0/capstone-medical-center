import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import {
  privateRecoveryForm,
  RECOVERY_FORM_SCRIPT,
} from "../scripts/private-recovery-form.js";

function fixture() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let killed = 0,
    input = "",
    args;
  child.stdin.on("data", (data) => {
    input += data;
  });
  child.kill = () => {
    killed++;
  };
  return {
    child,
    signals: new EventEmitter(),
    get killed() {
      return killed;
    },
    get input() {
      return JSON.parse(input);
    },
    get args() {
      return args;
    },
    spawnProcess: (...values) => {
      args = values;
      return child;
    },
  };
}
test("private recovery form carries values through pipes only and retains absolute display expiry", async () => {
  const f = fixture(),
    expiresAt = new Date(Date.now() + 30000).toISOString();
  const pending = privateRecoveryForm(
    {
      note: "Dummy only",
      fields: [{ label: "Dummy", value: "DUMMY-NOT-A-SECRET" }],
      expiresAt,
    },
    f,
  );
  assert.doesNotMatch(JSON.stringify(f.args), /DUMMY-NOT-A-SECRET/);
  assert.equal(f.input.expiresAt, expiresAt);
  f.child.stdout.write('READY\nRESULT:["dummy-result"]\n');
  f.child.emit("close", 0);
  assert.deepEqual(await pending, ["dummy-result"]);
  assert.equal(f.killed, 0);
  assert.match(RECOVERY_FORM_SCRIPT, /ToUniversalTime/);
});
test("private popup cancellation and Ctrl+C safely stop only the owned child", async () => {
  for (const cancellation of ["button", "interrupt"]) {
    const f = fixture(),
      pending = privateRecoveryForm({ note: "Dummy", fields: [] }, f);
    f.child.stdout.write("READY\n");
    if (cancellation === "button") {
      f.child.stdout.write("CANCELLED\n");
      f.child.emit("close", 0);
    } else f.signals.emit("SIGINT");
    assert.equal(await pending, null);
    assert.equal(f.killed, cancellation === "interrupt" ? 1 : 0);
  }
});
test("private popup rejects failed, malformed and secret-bearing output without echoing it", async () => {
  for (const output of [
    "FAILED\n",
    "READY\nRESULT:invalid-dummy\n",
    "READY\nRESULT:[123]\n",
  ]) {
    const f = fixture(),
      pending = privateRecoveryForm({ note: "Dummy", fields: [{}] }, f);
    f.child.stdout.write(output);
    await assert.rejects(
      pending,
      (error) =>
        !error.message.includes("invalid-dummy") &&
        /could not finish/.test(error.message),
    );
    assert.equal(f.killed, 1);
  }
});
