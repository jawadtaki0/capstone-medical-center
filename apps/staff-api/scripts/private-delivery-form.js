import { spawn } from "node:child_process";

const READY = "CEDAR_FORM_READY";
const CANCELLED = "CEDAR_FORM_CANCELLED";
const FAILED = "CEDAR_FORM_FAILED";
const RESULT = "CEDAR_FORM_RESULT:";
const MAX_OUTPUT = 32_768;

export class PrivateFormError extends Error {
  constructor(code) {
    const messages = {
      unavailable:
        "Windows PowerShell could not start. Retry from your signed-in desktop CMD; check that Windows PowerShell is available.",
      startup:
        "The private form did not report opening within 15 seconds. Its child was stopped. Retry from your signed-in desktop CMD, not a background service.",
      failed:
        "Windows could not open or finish the private form. Its child was stopped. Retry from your signed-in desktop CMD.",
      protocol:
        "The private form returned an unexpected response. Nothing was saved; retry the command.",
      timeout:
        "Private entry timed out after 10 minutes. Its child was stopped and nothing was saved; retry when ready.",
      interrupted: "Private entry cancelled. Nothing was saved.",
    };
    super(messages[code] ?? messages.failed);
    this.name = "PrivateFormError";
    this.code = code;
  }
}

// Only fixed UI text enters the command. User input returns through a private
// captured pipe, never through arguments, environment, console or a temp file.
export function formScript({ approval = false, checkOnly = false } = {}) {
  const fields = approval
    ? [
        "Delivery scope (one-time operator confirmation)",
        "Sending allowance (no replenishment)",
      ]
    : ["Dedicated Gmail sender", "Gmail App Password (not ordinary password)"];
  return `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$form = $null
try {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  # Check our own native window, not merely WinForms' managed Visible flag.
  Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class CedarEntryWindow { [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr handle); }'
  [System.Windows.Forms.Application]::EnableVisualStyles()
  $form = [System.Windows.Forms.Form]::new()
  $form.Text = 'Private Cedar Staff delivery setup${checkOnly ? " - popup check (no saving)" : " - do not screenshot"}'
  $form.ClientSize = [System.Drawing.Size]::new(620, 285)
  $form.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
  $form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedDialog
  $form.MaximizeBox = $false
  $form.MinimizeBox = $false
  $form.ShowInTaskbar = $true
  $form.AutoScaleMode = [System.Windows.Forms.AutoScaleMode]::Dpi
  $labels = @('${fields[0]}', '${fields[1]}')
  $boxes = @()
  for ($i = 0; $i -lt 2; $i++) {
    $label = [System.Windows.Forms.Label]::new()
    $label.Text = $labels[$i]
    $label.Location = [System.Drawing.Point]::new(20, (20 + $i * 75))
    $label.Size = [System.Drawing.Size]::new(580, 25)
    $form.Controls.Add($label)
    $box = [System.Windows.Forms.TextBox]::new()
    $box.Location = [System.Drawing.Point]::new(20, (48 + $i * 75))
    $box.Size = [System.Drawing.Size]::new(580, 25)
    $box.TabIndex = $i
    ${approval ? "" : "if ($i -eq 1) { $box.UseSystemPasswordChar = $true }"}
    ${approval ? "$box.Text = @('Staff self-service email', 'Existing approved allowance and usage unchanged')[$i]" : ""}
    ${checkOnly || approval ? "$box.ReadOnly = $true; $box.TabStop = $false" : ""}
    $form.Controls.Add($box)
    $boxes += $box
  }
  $note = [System.Windows.Forms.Label]::new()
  $note.Text = '${checkOnly ? "Popup check only: enter nothing. Cancel, Escape or X closes without saving." : approval ? "Enables delivery to employees own proposed emails, without a recipient list. Sends nothing now. Cancel saves nothing." : "Private local entry. Cancel, Escape or X saves nothing. Entry expires after 10 minutes."}'
  $note.Location = [System.Drawing.Point]::new(20, 170)
  $note.Size = [System.Drawing.Size]::new(580, 40)
  $form.Controls.Add($note)
  $ok = [System.Windows.Forms.Button]::new()
  $ok.Text = '${approval ? "Enable staff self-service email" : "Save encrypted credentials (sending OFF)"}'
  $ok.Size = [System.Drawing.Size]::new(390, 38)
  $ok.Location = [System.Drawing.Point]::new(20, 225)
  $ok.TabIndex = 2
  $ok.DialogResult = [System.Windows.Forms.DialogResult]::OK
  $ok.Enabled = ${checkOnly ? "$false" : "$true"}
  $form.Controls.Add($ok)
  ${checkOnly ? "" : "$form.AcceptButton = $ok"}
  $cancel = [System.Windows.Forms.Button]::new()
  $cancel.Text = 'Cancel'
  $cancel.Size = [System.Drawing.Size]::new(130, 38)
  $cancel.Location = [System.Drawing.Point]::new(470, 225)
  $cancel.TabIndex = 3
  $cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
  $form.Controls.Add($cancel)
  $form.CancelButton = $cancel
  $form.Add_Shown({
    # Explicitly present the GUI instead of inheriting hidden console startup.
    $form.WindowState = [System.Windows.Forms.FormWindowState]::Normal
    $form.TopMost = $true
    $form.Activate()
    $form.BringToFront()
    $form.TopMost = $false
    ${checkOnly ? "$cancel.Focus() | Out-Null" : approval ? "$ok.Focus() | Out-Null" : "$boxes[0].Focus() | Out-Null"}
    if (-not [CedarEntryWindow]::IsWindowVisible($form.Handle)) {
      [Console]::Out.WriteLine('${FAILED}')
      $form.Close()
      return
    }
    [Console]::Out.WriteLine('${READY}')
    [Console]::Out.Flush()
  })
  $answer = $form.ShowDialog()
  if ($answer -eq [System.Windows.Forms.DialogResult]::OK${checkOnly ? " -and $false" : ""}) {
    $values = @($boxes[0].Text, $boxes[1].Text)
    [Console]::Out.WriteLine('${RESULT}' + (ConvertTo-Json -InputObject $values -Compress))
  } else {
    [Console]::Out.WriteLine('${CANCELLED}')
  }
} catch {
  # Never emit exception text: it could include private field contents.
  [Console]::Out.WriteLine('${FAILED}')
  exit 1
} finally {
  if ($null -ne $form) {
    foreach ($box in $boxes) { $box.Clear() }
    $form.Dispose()
  }
}
`;
}

export function privateEntry(
  approval = false,
  {
    checkOnly = false,
    spawnProcess = spawn,
    signals = process,
    startupMs = 15_000,
    entryMs = 600_000,
    onReady = () => {},
  } = {},
) {
  return new Promise((resolveEntry, reject) => {
    let child;
    let settled = false;
    let ready = false;
    let answer;
    let buffer = "";
    let bytes = 0;
    let entryTimer;
    let startupTimer;

    function finish(error, value, stopChild = false) {
      if (settled) return;
      settled = true;
      clearTimeout(startupTimer);
      clearTimeout(entryTimer);
      signals.removeListener("SIGINT", interrupt);
      signals.removeListener("SIGTERM", interrupt);
      buffer = "";
      answer = undefined;
      // A cleanup error must not swallow the original safe failure message.
      if (stopChild && child) {
        try {
          child.kill();
        } catch {
          /* already exited */
        }
      }
      if (error) reject(error);
      else resolveEntry(value);
    }
    function interrupt() {
      finish(new PrivateFormError("interrupted"), undefined, true);
    }
    function fail(code) {
      finish(new PrivateFormError(code), undefined, true);
    }

    try {
      child = spawnProcess(
        "powershell.exe",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-STA",
          "-WindowStyle",
          "Normal",
          "-EncodedCommand",
          Buffer.from(formScript({ approval, checkOnly }), "utf16le").toString(
            "base64",
          ),
        ],
        {
          // windowsHide can suppress the initial native window, not only a console.
          // This is an explicitly interactive utility, never a background service.
          windowsHide: false,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    } catch {
      fail("unavailable");
      return;
    }

    startupTimer = setTimeout(() => fail("startup"), startupMs);
    signals.once("SIGINT", interrupt);
    signals.once("SIGTERM", interrupt);
    child.stdout.setEncoding("utf8");
    // Drain, but never log/parse raw PowerShell diagnostics (including CLIXML).
    child.stderr.resume();
    child.stdout.on("error", () => fail("failed"));
    child.stderr.on("error", () => fail("failed"));
    child.stdout.on("data", (part) => {
      if (settled) return;
      bytes += Buffer.byteLength(part);
      if (bytes > MAX_OUTPUT) {
        fail("protocol");
        return;
      }
      buffer += part;
      let newline;
      while (!settled && (newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line === FAILED) {
          fail("failed");
          return;
        }
        if (line === READY && !ready && answer === undefined) {
          ready = true;
          clearTimeout(startupTimer);
          entryTimer = setTimeout(() => fail("timeout"), entryMs);
          try {
            onReady();
          } catch {
            fail("failed");
            return;
          }
        } else if (ready && answer === undefined && line === CANCELLED) {
          answer = null;
        } else if (
          ready &&
          answer === undefined &&
          !checkOnly &&
          line.startsWith(RESULT)
        ) {
          try {
            const values = JSON.parse(line.slice(RESULT.length));
            if (
              !Array.isArray(values) ||
              values.length !== 2 ||
              values.some((value) => typeof value !== "string")
            )
              throw new Error();
            answer = values;
          } catch {
            fail("protocol");
            return;
          }
        } else {
          fail("protocol");
          return;
        }
      }
    });
    child.on("error", () => fail("unavailable"));
    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        fail("failed");
        return;
      }
      if (!ready || buffer || answer === undefined) {
        fail("protocol");
        return;
      }
      finish(null, answer);
    });
  });
}
