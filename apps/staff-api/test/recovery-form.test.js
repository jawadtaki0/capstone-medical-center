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

test("synthetic review copy data stays in pipes and display-only forms cannot return private values", async () => {
  const f = fixture(),
    now = Date.now();
  const options = {
    purpose: "hosted-review",
    reviewDisplay: true,
    fields: [
      {
        label: "Dummy username",
        value: "synthetic.dummy",
        readOnly: true,
        copyValue: true,
      },
    ],
    reviewCodePeriods: [
      {
        code: "000123",
        validFrom: new Date(now).toISOString(),
        validUntil: new Date(now + 30000).toISOString(),
      },
    ],
  };
  const pending = privateRecoveryForm(options, f);
  assert.doesNotMatch(JSON.stringify(f.args), /000123|synthetic\.dummy/);
  assert.equal(f.input.reviewDisplay, true);
  assert.ok(
    f.input.reviewCodePeriods[0].code === options.reviewCodePeriods[0].code,
  );
  f.child.stdout.write('READY\nRESULT:["synthetic.dummy"]\n');
  await assert.rejects(pending, /Private/);
  assert.equal(f.killed, 1);
  const normal = fixture();
  await assert.rejects(
    privateRecoveryForm({ ...options, purpose: "recovery" }, normal),
  );
  assert.equal(
    normal.args,
    undefined,
    "normal forms cannot opt into review code display",
  );
});
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

test("password copy controls require explicit read-only private opt-in and keep values off command arguments", async () => {
  const f = fixture();
  const pending = privateRecoveryForm(
    {
      note: "Dummy only",
      fields: [
        {
          label: "Dummy password",
          value: "DUMMY-COPY-ONLY",
          private: true,
          readOnly: true,
          copyPassword: true,
        },
      ],
    },
    f,
  );
  assert.equal(f.input.fields[0].copyPassword, true);
  assert.doesNotMatch(JSON.stringify(f.args), /DUMMY-COPY-ONLY/);
  assert.match(
    RECOVERY_FORM_SCRIPT,
    /\$field\.readOnly -and \(\(\$field\.private -and \(\$field\.copyPassword -or \$field\.copySecret\)\) -or \(\$options\.reviewDisplay -and \$field\.copyValue\)\)/,
  );
  assert.match(
    RECOVERY_FORM_SCRIPT,
    /Clipboard\]::SetText\(\$this\.Tag\.Text\)/,
  );
  assert.match(
    RECOVERY_FORM_SCRIPT,
    /\$this\.Tag\.UseSystemPasswordChar = -not/,
  );
  f.child.stdout.write("READY\nCANCELLED\n");
  f.child.emit("close", 0);
  assert.equal(await pending, null);
});

test("synthetic authenticator seed copy uses an explicit private read-only opt-in and a distinct label", async () => {
  const f = fixture();
  const pending = privateRecoveryForm(
    {
      note: "Dummy only",
      fields: [
        {
          label: "Dummy setup seed",
          value: "DUMMY-SEED-NOT-VALID",
          readOnly: true,
          private: true,
          copySecret: true,
          copyLabel: "Copy setup seed",
        },
      ],
    },
    f,
  );
  assert.equal(f.input.fields[0].copySecret, true);
  assert.equal(f.input.fields[0].copyLabel, "Copy setup seed");
  assert.doesNotMatch(JSON.stringify(f.args), /DUMMY-SEED-NOT-VALID/);
  assert.match(
    RECOVERY_FORM_SCRIPT,
    /\$copy\.Text = if \(\$field\.copyLabel\)/,
  );
  f.child.stdout.write("READY\nCANCELLED\n");
  f.child.emit("close", 0);
  assert.equal(await pending, null);
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
