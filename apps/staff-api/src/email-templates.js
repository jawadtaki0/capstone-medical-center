// Pure presentation: no configuration, delivery, storage or challenge changes.
export function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character],
  );
}

function expiryText(expiresAt) {
  // The caller supplies the original request deadline, including any session cap.
  if (!(expiresAt instanceof Date) || !Number.isFinite(expiresAt.getTime()))
    return "Check the application for this request's expiry. Resending does not extend the original deadline.";
  const deadline = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Beirut",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(expiresAt);
  return `Expires on ${deadline} (Asia/Beirut). Resending does not extend this deadline.`;
}

function layout({ heading, preview, body }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(heading)}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f3f8fc; color: #263e50; font-family: 'Segoe UI', Arial, sans-serif; font-size: 16px; line-height: 1.6;">
  <!-- Preview text -->
  <div aria-hidden="true" style="display: none; max-height: 0; overflow: hidden; opacity: 0; color: transparent; font-size: 1px; line-height: 1px; mso-hide: all;">${escapeHtml(preview)}${"&#8204;&nbsp;".repeat(80)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width: 100%; background-color: #f3f8fc;">
    <tr>
      <td align="center" style="padding: 24px 12px;">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="width: 100%; max-width: 560px; border: 1px solid #d2e2ed; border-radius: 14px; background-color: #ffffff;">
          <tr>
            <td style="padding: 22px 24px; background-color: #226b9d; border-radius: 13px 13px 0 0; color: #ffffff; font-size: 24px; font-weight: 700; line-height: 1.3;">Cedar Staff</td>
          </tr>
          <tr>
            <td style="padding: 28px 24px;">
              <h1 style="margin: 0 0 18px; color: #163c55; font-size: 24px; font-weight: 700; line-height: 1.35;">${escapeHtml(heading)}</h1>
              ${body}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function paragraph(text, extraStyle = "") {
  return `<p style="margin: 0 0 18px; ${extraStyle}">${escapeHtml(text)}</p>`;
}

export function verificationEmail({ code, expiresAt }) {
  const heading = "Verify your email address";
  const instruction =
    "Enter this code in the Cedar Staff application to confirm that you can receive email at this address.";
  const expiry = expiryText(expiresAt);
  const safety =
    "Do not share this code. If you did not request verification, ignore this message.";
  // Keep the code as text: converting to a number would discard leading zeros.
  const value = String(code);
  return {
    subject: "Verify your email — Cedar Staff",
    text: `Cedar Staff\n\n${heading}\n\n${instruction}\n\nVerification code: ${value}\n\n${expiry}\n\n${safety}`,
    html: layout({
      heading,
      preview:
        "Confirm your email address in the Cedar Staff application. This message contains instructions for a requested verification. If you did not request it, ignore this message.",
      body: `${paragraph(instruction)}
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width: 100%; margin-bottom: 20px;">
          <tr><td align="center" style="padding: 18px 8px; background-color: #eaf4fb; border: 1px solid #d2e2ed; border-radius: 10px;">
            <p style="margin: 0 0 6px; color: #526979; font-size: 14px;">Verification code</p>
            <p data-verification-code style="margin: 0; color: #226b9d; font-family: Consolas, 'Courier New', monospace; font-size: 30px; font-weight: 700; letter-spacing: 2px; line-height: 1.4; user-select: text; -webkit-user-select: text;">${escapeHtml(value)}</p>
          </td></tr>
        </table>
        ${paragraph(expiry, "color: #526979; font-size: 14px;")}
        ${paragraph(safety, "margin-bottom: 0; padding-top: 18px; border-top: 1px solid #d2e2ed; color: #526979; font-size: 14px;")}`,
    }),
  };
}

export function emailChangedNotification() {
  const heading = "Your email address was changed";
  const explanation =
    "The email address saved for your Cedar Staff account was changed.";
  const safety =
    "If you do not recognize this change, report it to an authorized administrator.";
  return {
    subject: "Your email address was changed — Cedar Staff",
    text: `Cedar Staff\n\n${heading}\n\n${explanation}\n\n${safety}`,
    html: layout({
      heading,
      preview:
        "A change was made to the email address saved for your Cedar Staff account. If you do not recognize this change, report it to an authorized administrator.",
      body: `${paragraph(explanation)}${paragraph(safety, "margin-bottom: 0; padding: 16px; border: 1px solid #d2e2ed; border-radius: 10px; background-color: #eaf4fb;")}`,
    }),
  };
}
