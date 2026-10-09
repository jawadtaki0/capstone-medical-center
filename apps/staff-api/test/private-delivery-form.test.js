import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import test from "node:test";
import {
  formScript,
  privateEntry,
  PrivateFormError,
} from "../scripts/private-delivery-form.js";

function fixture(options = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
  };
  const signals = new EventEmitter();
  let invocation;
  const promise = privateEntry(false, {
    signals,
    startupMs: 200,
    entryMs: 200,
    spawnProcess: (...args) => {
      invocation = args;
      return child;
    },
    ...options,
  });
  const line = (value) => child.stdout.write(`${value}\r\n`);
  return { child, signals, promise, line, invocation };
}

test("interactive STA launch uses encoded fixed text, visible startup and captured pipes", async () => {
  const f = fixture();
  assert.equal(f.invocation[0], "powershell.exe");
  assert.equal(f.invocation[2].windowsHide, false);
  assert.deepEqual(f.invocation[2].stdio, ["ignore", "pipe", "pipe"]);
  assert.ok(f.invocation[1].includes("-STA"));
  assert.ok(f.invocation[1].includes("-EncodedCommand"));
  assert.equal(
    f.invocation[1][f.invocation[1].indexOf("-WindowStyle") + 1],
    "Normal",
  );
  const source = Buffer.from(f.invocation[1].at(-1), "base64").toString(
    "utf16le",
  );
  assert.ok(source.includes("UseSystemPasswordChar = $true"));
  assert.ok(source.includes("$ErrorActionPreference"));
  assert.ok(source.includes("$form.Add_Shown"));
  f.line("CEDAR_FORM_READY");
  f.line("CEDAR_FORM_CANCELLED");
  f.child.emit("close", 0);
  assert.equal(await f.promise, null);
  assert.equal(f.signals.listenerCount("SIGINT"), 0);
});

test("fragmented UTF-8 result is private and returned only after clean child exit", async () => {
  let shown = 0;
  const f = fixture({ onReady: () => shown++ });
  f.child.stdout.write("CEDAR_FORM_RE");
  f.child.stdout.write(
    'ADY\r\nCEDAR_FORM_RESULT:["synthetic@example.invalid","synthetic-not-a-credential"]\r\n',
  );
  f.child.emit("close", 0);
  assert.deepEqual(await f.promise, [
    "synthetic@example.invalid",
    "synthetic-not-a-credential",
  ]);
  assert.equal(shown, 1);
});

test("cancel/X protocol does not return any private values", async () => {
  const f = fixture();
  f.line("CEDAR_FORM_READY");
  f.line("CEDAR_FORM_CANCELLED");
  f.child.emit("close", 0);
  assert.equal(await f.promise, null);
  assert.equal(f.child.killed, false);
});

test("no-save popup check cannot accept a result", async () => {
  assert.match(formScript({ checkOnly: true }), /\$ok.Enabled = \$false/);
  assert.match(formScript({ checkOnly: true }), /\$box.ReadOnly = \$true/);
  const f = fixture({ checkOnly: true });
  f.line("CEDAR_FORM_READY");
  f.line('CEDAR_FORM_RESULT:["x","y"]');
  await assert.rejects(f.promise, { code: "protocol" });
  assert.equal(f.child.killed, true);
});

test("one-time self-service confirmation has no recipient list or editable allowance", () => {
  const source = formScript({ approval: true });
  assert.match(source, /Enable staff self-service email/);
  assert.match(source, /\$box.ReadOnly = \$true/);
  assert.match(source, /Existing approved allowance and usage unchanged/);
  assert.doesNotMatch(
    source,
    /Selected receiving emails|comma-separated|Approved total sending attempts/,
  );
});

test("missing PowerShell reports a safe error and removes handlers", async () => {
  const f = fixture();
  f.child.emit("error", new Error("sensitive OS diagnostic must not escape"));
  await assert.rejects(
    f.promise,
    (error) =>
      error.code === "unavailable" && !error.message.includes("sensitive"),
  );
  assert.equal(f.signals.listenerCount("SIGINT"), 0);
});

test("synchronous spawn failure is bounded and safe", async () => {
  await assert.rejects(
    privateEntry(false, {
      spawnProcess: () => {
        throw new Error("private diagnostics");
      },
    }),
    { code: "unavailable" },
  );
});

test("no shown signal times out and stops only the owned child", async () => {
  const f = fixture({ startupMs: 10 });
  await assert.rejects(f.promise, { code: "startup" });
  assert.equal(f.child.killed, true);
});

test("shown signal cancels startup timer but entry still has a bounded deadline", async () => {
  const f = fixture({ startupMs: 5, entryMs: 20 });
  f.line("CEDAR_FORM_READY");
  await assert.rejects(f.promise, { code: "timeout" });
  assert.equal(f.child.killed, true);
});

test("Ctrl+C cancels, kills only own child and does not return captured input", async () => {
  const f = fixture();
  f.line("CEDAR_FORM_READY");
  f.line(
    'CEDAR_FORM_RESULT:["synthetic@example.invalid","synthetic-not-a-credential"]',
  );
  f.signals.emit("SIGINT");
  await assert.rejects(f.promise, { code: "interrupted" });
  assert.equal(f.child.killed, true);
  f.child.emit("close", 0); // Exit after interruption cannot turn into success.
});

test("PowerShell errors are drained but never exposed", async () => {
  const f = fixture();
  f.child.stderr.write("sensitive diagnostic and synthetic-secret");
  f.line("CEDAR_FORM_FAILED");
  f.child.emit("close", 1);
  await assert.rejects(
    f.promise,
    (error) =>
      error instanceof PrivateFormError &&
      error.code === "failed" &&
      !error.message.includes("secret"),
  );
});

for (const [label, lines, exit] of [
  ["early empty exit", [], 0],
  ["nonzero exit", ["CEDAR_FORM_READY"], 1],
  ["result before readiness", ['CEDAR_FORM_RESULT:["x","y"]'], 0],
  ["malformed result", ["CEDAR_FORM_READY", "CEDAR_FORM_RESULT:not-json"], 0],
  ["wrong shape", ["CEDAR_FORM_READY", 'CEDAR_FORM_RESULT:["x",42]'], 0],
  ["duplicate ready", ["CEDAR_FORM_READY", "CEDAR_FORM_READY"], 0],
  [
    "extra response",
    ["CEDAR_FORM_READY", "CEDAR_FORM_CANCELLED", "unexpected"],
    0,
  ],
]) {
  test(`${label} fails safely rather than hanging or returning input`, async () => {
    const f = fixture();
    for (const line of lines) f.line(line);
    f.child.emit("close", exit);
    await assert.rejects(f.promise, PrivateFormError);
  });
}

test("oversized child output cannot grow memory indefinitely", async () => {
  const f = fixture();
  f.child.stdout.write("x".repeat(32_769));
  await assert.rejects(f.promise, { code: "protocol" });
  assert.equal(f.child.killed, true);
});

test("stream and readiness-callback failures also stop safely", async () => {
  const f = fixture();
  f.child.stdout.emit("error", new Error("private stream details"));
  await assert.rejects(f.promise, { code: "failed" });
  const callback = fixture({
    onReady: () => {
      throw new Error("private callback details");
    },
  });
  callback.line("CEDAR_FORM_READY");
  await assert.rejects(callback.promise, { code: "failed" });
});

test("cleanup errors cannot swallow safe interruption result", async () => {
  const f = fixture();
  f.child.kill = () => {
    throw new Error("private OS details");
  };
  f.signals.emit("SIGTERM");
  await assert.rejects(f.promise, { code: "interrupted" });
});

// This test constructs only our blank read-only popup. It never opens a
// credential file, connects to a provider, or touches any database. A WinForms
// timer activates that test form's own Cancel button after its Shown event.
for (const mode of [
  {
    label: "no-save check / Cancel",
    checkOnly: true,
    approval: false,
    close: "$cancel.PerformClick()",
  },
  {
    label: "credential form / window X",
    checkOnly: false,
    approval: false,
    close: "$form.Close()",
  },
  {
    label: "self-service confirmation / Cancel",
    checkOnly: false,
    approval: true,
    close: "$cancel.PerformClick()",
  },
]) {
  test(
    `Windows native ${mode.label} is visible and exits without values`,
    { skip: process.platform !== "win32", timeout: 25_000 },
    async () => {
      let nativeChecked = false;
      let ready = false;
      const result = await privateEntry(mode.approval, {
        checkOnly: mode.checkOnly,
        onReady: () => {
          ready = true;
        },
        spawnProcess: (command, args, options) => {
          let script = Buffer.from(args.at(-1), "base64").toString("utf16le");
          script = script.replace(
            "$answer = $form.ShowDialog()",
            `
  Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class CedarPopupCheck { [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr handle); }'
  $checkTimer = [System.Windows.Forms.Timer]::new()
  $checkTimer.Interval = 700
  $checkTimer.Add_Tick({
    $checkTimer.Stop()
    if ([CedarPopupCheck]::IsWindowVisible($form.Handle) -and $form.Visible -and $form.ShowInTaskbar -and ($boxes[0].ReadOnly -eq ${mode.checkOnly || mode.approval ? "$true" : "$false"}) -and ($boxes[1].UseSystemPasswordChar -eq ${mode.approval ? "$false" : "$true"}) -and ($ok.Enabled -eq ${mode.checkOnly ? "$false" : "$true"})) {
      [Console]::Error.Write('NATIVE_POPUP_CHECK_OK')
    }
    ${mode.close}
  })
  $checkTimer.Start()
  $answer = $form.ShowDialog()
  $checkTimer.Dispose()`,
          );
          const modified = [
            ...args.slice(0, -1),
            Buffer.from(script, "utf16le").toString("base64"),
          ];
          const child = spawn(command, modified, options);
          let diagnostic = "";
          child.stderr.on("data", (part) => {
            diagnostic += part;
            nativeChecked = diagnostic.includes("NATIVE_POPUP_CHECK_OK");
          });
          return child;
        },
      });
      assert.equal(ready, true);
      assert.equal(nativeChecked, true);
      assert.equal(result, null);
    },
  );
}

test(
  "actual Windows form construction error produces only a safe failure",
  { skip: process.platform !== "win32", timeout: 20_000 },
  async () => {
    await assert.rejects(
      privateEntry(false, {
        checkOnly: true,
        spawnProcess: (command, args, options) => {
          const script = Buffer.from(args.at(-1), "base64")
            .toString("utf16le")
            .replace(
              "Add-Type -AssemblyName System.Windows.Forms",
              "throw 'synthetic private diagnostic that must not escape'",
            );
          return spawn(
            command,
            [
              ...args.slice(0, -1),
              Buffer.from(script, "utf16le").toString("base64"),
            ],
            options,
          );
        },
      }),
      (error) =>
        error.code === "failed" && !error.message.includes("synthetic"),
    );
  },
);
