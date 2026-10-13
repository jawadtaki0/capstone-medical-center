import { spawn } from "node:child_process";

// Fixed reviewed script. Private values travel only through captured pipes, not
// command arguments, environment variables, temporary files or console output.
export const RECOVERY_FORM_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$form = $null
$boxes = @()
try {
  $options = ConvertFrom-Json ([Console]::In.ReadLine())
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class CedarRecoveryWindow { [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr handle); }'
  [System.Windows.Forms.Application]::EnableVisualStyles()
  $form = [System.Windows.Forms.Form]::new()
  $form.Text = 'Private Cedar Staff recovery - do not screenshot'
  $form.ClientSize = [System.Drawing.Size]::new(660, [Math]::Min(680, 145 + 68 * $options.fields.Count))
  $form.StartPosition = 'CenterScreen'
  $form.AutoScaleMode = 'Dpi'
  $form.AutoScroll = $true
  $form.BackColor = [System.Drawing.ColorTranslator]::FromHtml('#f3f8fc')
  $form.ForeColor = [System.Drawing.ColorTranslator]::FromHtml('#163c55')
  $form.MaximizeBox = $false
  $form.ShowInTaskbar = $true
  $note = [System.Windows.Forms.Label]::new()
  $note.Text = $options.note
  $note.Location = [System.Drawing.Point]::new(20, 12)
  $note.Size = [System.Drawing.Size]::new(610, 55)
  $form.Controls.Add($note)
  $y = 75
  foreach ($field in $options.fields) {
    $label = [System.Windows.Forms.Label]::new()
    $label.Text = $field.label
    $label.Location = [System.Drawing.Point]::new(20, $y)
    $label.Size = [System.Drawing.Size]::new(610, 22)
    $form.Controls.Add($label)
    $box = [System.Windows.Forms.TextBox]::new()
    $box.Location = [System.Drawing.Point]::new(20, ($y + 24))
    $box.Size = [System.Drawing.Size]::new(610, 25)
    $box.MaxLength = 512
    $box.Text = $field.value
    $box.ReadOnly = [bool]$field.readOnly
    $box.UseSystemPasswordChar = [bool]$field.private
    $form.Controls.Add($box)
    $boxes += $box
    $y += 68
  }
  $ok = [System.Windows.Forms.Button]::new()
  $ok.Text = 'Confirm and continue'
  $ok.Location = [System.Drawing.Point]::new(20, $y)
  $ok.Size = [System.Drawing.Size]::new(240, 38)
  $ok.DialogResult = 'OK'
  $form.Controls.Add($ok)
  $form.AcceptButton = $ok
  $cancel = [System.Windows.Forms.Button]::new()
  $cancel.Text = 'Cancel'
  $cancel.Location = [System.Drawing.Point]::new(280, $y)
  $cancel.Size = [System.Drawing.Size]::new(140, 38)
  $cancel.DialogResult = 'Cancel'
  $form.Controls.Add($cancel)
  $form.CancelButton = $cancel
  $timer = [System.Windows.Forms.Timer]::new()
  $timer.Interval = 250
  $expires = [DateTime]::Parse($options.expiresAt).ToUniversalTime()
  $timer.Add_Tick({ if ([DateTime]::UtcNow -ge $expires) { foreach ($box in $boxes) { $box.Clear() }; $form.DialogResult = 'Cancel'; $form.Close() } })
  $form.Add_Shown({
    if (-not [CedarRecoveryWindow]::IsWindowVisible($form.Handle)) { throw 'Private window unavailable' }
    if ([DateTime]::UtcNow -ge $expires) {
      foreach ($box in $boxes) { $box.Clear() }
      [Console]::Out.WriteLine('READY')
      $form.DialogResult = 'Cancel'; $form.Close(); return
    }
    $form.TopMost = $true
    $form.Activate()
    $form.BringToFront()
    $form.TopMost = $false
    if ($boxes.Count -gt 0) { $boxes[0].Focus() | Out-Null }
    $timer.Start()
    [Console]::Out.WriteLine('READY')
    [Console]::Out.Flush()
  })
  if ($form.ShowDialog() -eq 'OK' -and [DateTime]::UtcNow -lt $expires) {
    $values = @($boxes | ForEach-Object { $_.Text })
    [Console]::Out.WriteLine('RESULT:' + (ConvertTo-Json -InputObject $values -Compress))
  } else { [Console]::Out.WriteLine('CANCELLED') }
} catch { [Console]::Out.WriteLine('FAILED'); exit 1 }
finally {
  if ($null -ne $timer) { $timer.Stop(); $timer.Dispose() }
  foreach ($box in $boxes) { $box.Clear() }
  if ($null -ne $form) { $form.Dispose() }
}
`;

export function privateRecoveryForm(
  {
    note,
    fields,
    expiryMs = 300000,
    expiresAt = new Date(Date.now() + expiryMs).toISOString(),
  },
  { spawnProcess = spawn, signals = process } = {},
) {
  return new Promise((resolve, reject) => {
    let child,
      settled = false,
      ready = false,
      answer,
      buffer = "",
      bytes = 0,
      entryTimer;
    const safeFailure = () =>
      new Error(
        "Private recovery form could not finish. Nothing was acknowledged. Retry from your signed-in Windows desktop; never put secrets in CMD or chat.",
      );
    function finish(error, value, stop = false) {
      if (settled) return;
      settled = true;
      clearTimeout(startupTimer);
      clearTimeout(entryTimer);
      signals.removeListener("SIGINT", interrupt);
      signals.removeListener("SIGTERM", interrupt);
      buffer = "";
      answer = undefined;
      if (stop) {
        try {
          child?.kill();
        } catch {
          /* Owned child only. */
        }
      }
      if (error) reject(error);
      else resolve(value);
    }
    const interrupt = () => finish(null, null, true);
    const startupTimer = setTimeout(
      () => finish(safeFailure(), null, true),
      15000,
    );
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
          Buffer.from(RECOVERY_FORM_SCRIPT, "utf16le").toString("base64"),
        ],
        { windowsHide: false, stdio: ["pipe", "pipe", "pipe"] },
      );
      child.stdin.on("error", () => finish(safeFailure(), null, true));
      child.stdin.end(JSON.stringify({ note, fields, expiresAt }) + "\n");
      signals.once("SIGINT", interrupt);
      signals.once("SIGTERM", interrupt);
      child.stderr.resume();
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (data) => {
        bytes += Buffer.byteLength(data);
        if (bytes > 32768) return finish(safeFailure(), null, true);
        buffer += data;
        let index;
        while (!settled && (index = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (line === "READY" && !ready) {
            ready = true;
            clearTimeout(startupTimer);
            entryTimer = setTimeout(
              interrupt,
              Math.max(0, Date.parse(expiresAt) - Date.now()) + 1000,
            );
          } else if (ready && line === "CANCELLED") answer = null;
          else if (ready && line.startsWith("RESULT:")) {
            try {
              const result = JSON.parse(line.slice(7));
              if (
                !Array.isArray(result) ||
                result.length !== fields.length ||
                result.some(
                  (value) => typeof value !== "string" || value.length > 512,
                )
              )
                throw new Error();
              answer = result;
            } catch {
              finish(safeFailure(), null, true);
            }
          } else finish(safeFailure(), null, true);
        }
      });
      child.on("error", () => finish(safeFailure(), null, true));
      child.on("close", (code) => {
        if (!ready || code !== 0 || answer === undefined || buffer)
          finish(safeFailure());
        else finish(null, answer);
      });
    } catch {
      finish(safeFailure(), null, true);
    }
  });
}
