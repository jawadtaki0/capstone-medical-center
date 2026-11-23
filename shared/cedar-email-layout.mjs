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

export function cedarEmailLayout({
  heading,
  preview,
  body,
  brand = "Cedar Staff",
  language = "en",
}) {
  return `<!doctype html>
<html lang="${escapeHtml(language)}"${language === "ar" ? ' dir="rtl"' : ""}>
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
            <td style="padding: 22px 24px; background-color: #226b9d; border-radius: 13px 13px 0 0; color: #ffffff; font-size: 24px; font-weight: 700; line-height: 1.3;">${escapeHtml(brand)}</td>
          </tr>
          <tr>
            <td style="padding: 28px 24px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td align="center" style="padding-bottom: 18px;">
                    <img src="https://cmc-cedar.site/cedar-email-logo-v1.png" width="112" height="86" alt="${language === "ar" ? "مركز سيدر الطبي" : "Cedar Medical Center"}" style="display: block; width: 112px; height: 86px; border: 0;">
                  </td>
                </tr>
              </table>
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

export function paragraph(text, extraStyle = "") {
  return `<p style="margin: 0 0 18px; ${extraStyle}">${escapeHtml(text)}</p>`;
}
