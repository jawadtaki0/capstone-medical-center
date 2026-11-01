import { spawn } from "node:child_process";

// Fixed reviewed script. Private values travel only through captured pipes, not
// command arguments, environment variables, temporary files or console output.
export const RECOVERY_FORM_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$form = $null
$boxes = @()
$reviewCodeBox = $null
$reviewCodeCopy = $null
$reviewCodeExpiry = $null
function Update-CedarReviewCode {
  if (-not $options.reviewDisplay -or $null -eq $reviewCodeBox) { return }
  $at = [DateTime]::UtcNow
  $period = @($options.reviewCodePeriods | Where-Object { [DateTime]::Parse($_.validFrom).ToUniversalTime() -le $at -and $at -lt [DateTime]::Parse($_.validUntil).ToUniversalTime() }) | Select-Object -First 1
  if ($null -eq $period) {
    $reviewCodeBox.Clear(); $reviewCodeCopy.Enabled = $false
    $reviewCodeExpiry.Text = 'Code unavailable or expired. Reopen the private viewer.'
    return
  }
  if ($reviewCodeBox.Text -ne $period.code) { $reviewCodeBox.Text = $period.code; $reviewCodeCopy.Text = 'Copy current code' }
  $reviewCodeCopy.Enabled = $true
  $remaining = [Math]::Max(0, [Math]::Ceiling(([DateTime]::Parse($period.validUntil).ToUniversalTime() - $at).TotalSeconds))
  $reviewCodeExpiry.Text = 'Expires in ' + $remaining + ' seconds. Refreshes automatically.'
}
try {
  $options = ConvertFrom-Json ([Console]::In.ReadLine())
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class CedarRecoveryWindow { [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr handle); }'
  [System.Windows.Forms.Application]::EnableVisualStyles()
  $form = [System.Windows.Forms.Form]::new()
  $form.Text = $options.title
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
    if ($options.reviewDisplay -and $field.section) {
      $section = [System.Windows.Forms.Label]::new()
      $section.Text = $field.section
      $section.Location = [System.Drawing.Point]::new(20, $y)
      $section.Size = [System.Drawing.Size]::new(610, 28)
      $section.Font = [System.Drawing.Font]::new('Segoe UI', 10, [System.Drawing.FontStyle]::Bold)
      $form.Controls.Add($section); $y += 34
    }
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
    $box.UseSystemPasswordChar = [bool]$field.private -and -not ($options.reviewDisplay -and $field.initialVisible)
    if ($field.private -and $field.asteriskMask -and -not $field.readOnly) {
      $box.UseSystemPasswordChar = $false
      $box.PasswordChar = '*'
    }
    $form.Controls.Add($box)
    $boxes += $box
    if ($field.readOnly -and (($field.private -and ($field.copyPassword -or $field.copySecret)) -or ($options.reviewDisplay -and $field.copyValue))) {
      $box.Width = 360
      $copy = [System.Windows.Forms.Button]::new()
      $copy.Text = if ($field.copyLabel) { $field.copyLabel } else { 'Copy password' }
      $copy.AccessibleName = $field.label + ': ' + $copy.Text
      $copy.Location = [System.Drawing.Point]::new(390, ($y + 22))
      $copy.Size = [System.Drawing.Size]::new(130, 30)
      $copy.Tag = $box
      $copy.Add_Click({
        try {
          if ([DateTime]::UtcNow -ge $expires) { $form.Close(); return }
          Update-CedarReviewCode
          if (-not $this.Enabled) { return }
          [System.Windows.Forms.Clipboard]::SetText($this.Tag.Text)
          $this.Text = 'Copied'
        } catch { $this.Text = 'Copy failed; retry' }
      })
      $form.Controls.Add($copy)
      if ($options.reviewDisplay -and $field.currentCode) {
        $reviewCodeBox = $box; $reviewCodeCopy = $copy
        $box.Font = [System.Drawing.Font]::new('Consolas', 14, [System.Drawing.FontStyle]::Bold)
        $reviewCodeExpiry = [System.Windows.Forms.Label]::new()
        $reviewCodeExpiry.Location = [System.Drawing.Point]::new(20, ($y + 52))
        $reviewCodeExpiry.Size = [System.Drawing.Size]::new(610, 20)
        $form.Controls.Add($reviewCodeExpiry)
      }
      if ($field.private) {
      $show = [System.Windows.Forms.Button]::new()
      $show.Text = if ($box.UseSystemPasswordChar) { 'Show' } else { 'Hide' }
      $show.AccessibleName = $field.label + ': Show or hide private value'
      $show.Location = [System.Drawing.Point]::new(530, ($y + 22))
      $show.Size = [System.Drawing.Size]::new(100, 30)
      $show.Tag = $box
      $show.Add_Click({
        if ([DateTime]::UtcNow -ge $expires) { $form.Close(); return }
        $this.Tag.UseSystemPasswordChar = -not $this.Tag.UseSystemPasswordChar
        if ($this.Tag.UseSystemPasswordChar) { $this.Text = 'Show' } else { $this.Text = 'Hide' }
      })
      $form.Controls.Add($show)
      }
    }
    $y += if ($options.reviewDisplay -and $field.currentCode) { 90 } else { 68 }
  }
  $ok = [System.Windows.Forms.Button]::new()
  $ok.Text = if ($options.reviewDisplay) { 'Close' } else { 'Confirm and continue' }
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
  if ($options.reviewDisplay) { $cancel.Visible = $false; $ok.DialogResult = 'Cancel'; $form.CancelButton = $ok }
  $timer = [System.Windows.Forms.Timer]::new()
  $timer.Interval = 250
  $expires = [DateTime]::Parse($options.expiresAt).ToUniversalTime()
  $timer.Add_Tick({ if ([DateTime]::UtcNow -ge $expires) { foreach ($box in $boxes) { $box.Clear() }; $form.DialogResult = 'Cancel'; $form.Close() } else { Update-CedarReviewCode } })
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
    Update-CedarReviewCode
    [Console]::Out.WriteLine('READY')
    [Console]::Out.Flush()
  })
  $dialogResult = $form.ShowDialog()
  if (-not $options.reviewDisplay -and $dialogResult -eq 'OK' -and [DateTime]::UtcNow -lt $expires) {
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
    purpose = "recovery",
    reviewDisplay = false,
    reviewCodePeriods,
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
      if (
        reviewDisplay &&
        (purpose !== "hosted-review" ||
          !Array.isArray(reviewCodePeriods) ||
          reviewCodePeriods.length < 1 ||
          reviewCodePeriods.length > 11 ||
          !fields.every((field) => field.readOnly) ||
          reviewCodePeriods.some(
            (period) =>
              !/^\d{6}$/.test(period.code) ||
              !Number.isFinite(Date.parse(period.validFrom)) ||
              !Number.isFinite(Date.parse(period.validUntil)) ||
              Date.parse(period.validUntil) - Date.parse(period.validFrom) !==
                30000,
          ))
      )
        throw safeFailure();
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
      child.stdin.end(
        JSON.stringify({
          note,
          fields,
          expiresAt,
          ...(reviewDisplay ? { reviewDisplay: true, reviewCodePeriods } : {}),
          title:
            purpose === "hosted-review"
              ? "Private Cedar hosted review setup - do not screenshot"
              : purpose === "hosted-normal"
                ? "Private Cedar capstone hosting setup - do not screenshot"
                : "Private Cedar Staff recovery - do not screenshot",
        }) + "\n",
      );
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
          else if (ready && !reviewDisplay && line.startsWith("RESULT:")) {
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
