import { readFile } from "node:fs/promises";

const escapeHtml = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char],
  );
const date = (value) =>
  value
    ? new Intl.DateTimeFormat("en-GB", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "Asia/Beirut",
      }).format(new Date(value))
    : "—";

export async function renderLabPdf(
  order,
  patient,
  finalizedAt,
  corrected,
  version,
) {
  const sections = order.tests
    .map(
      (test) => `
    <section><h2 dir="auto">${escapeHtml(test.name)}</h2>
    ${
      test.cancelled
        ? "<p>Cancelled — no result reported</p>"
        : `
    <table><thead><tr><th>Test</th><th>Result</th><th>Unit</th><th>Reference interval</th></tr></thead>
    <tbody>${test.fields
      .map(
        (field, index) =>
          `<tr>${[field.name, test.results[index], field.unit, field.reference]
            .map((value) => `<td dir="auto">${escapeHtml(value)}</td>`)
            .join("")}</tr>`,
      )
      .join("")}</tbody></table>`
    }
    </section>`,
    )
    .join("");
  const rows = [
    ["Patient", order.patientName, "Order No.", "LAB-" + order._id],
    ["Patient ID", order.patientNumber, "Order Date", date(order.createdAt)],
    [
      "Date of Birth",
      patient.dateOfBirth,
      "Collection Date",
      date(order.history.findLast((event) => event.action === "collect")?.at),
    ],
    ["Sex", patient.gender, "", ""],
  ];
  const [logo, stamp] = await Promise.all([
    readFile(
      new URL("../../../shared/cedar-brand/cedar-logo.png", import.meta.url),
      "base64",
    ),
    readFile(
      new URL("../assets/lab-stamp-sample.png", import.meta.url),
      "base64",
    ),
  ]);
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ channel: "msedge", timeout: 15000 });
  try {
    const page = await browser.newPage({
      javaScriptEnabled: false,
      offline: true,
    });
    await page.setContent(
      `<!doctype html><meta charset="utf-8"><style>
      body{font:11pt Arial,sans-serif;color:#111;margin:0}
      header{text-align:center;margin-bottom:24px} .brand{display:block;width:153px;height:auto;margin:0 auto}
      .sample{font-size:10pt;font-weight:bold;letter-spacing:.12em;margin-top:6px}
      h1{font-size:19pt;margin:14px 0 5px} h2{font-size:14pt;background:#e5e5e5;padding:6px 9px;margin:21px 0 4px;break-after:avoid}
      table{width:100%;border-collapse:collapse;table-layout:fixed} th,td{padding:5px 8px;overflow-wrap:anywhere}
      th{text-align:left} tr{break-inside:avoid} .identity td:nth-child(odd){font-weight:bold;width:16%}
      .identity td:nth-child(even){width:34%} section p{padding:0 8px}
      footer{margin-top:20px;display:flex;align-items:center;justify-content:space-between;gap:24px;break-inside:avoid}
      footer p{margin:5px 0} .stamp{width:126px;height:126px;object-fit:contain;flex:none}
    </style><header><img class="brand" src="data:image/png;base64,${logo}" alt="Cedar Medical Center · مركز سيدر الطبي">
    <h1>Laboratory Report</h1>
    <div>${corrected ? "Corrected report · " : ""}Version ${version}</div>
    <div class="sample">SAMPLE · FICTIONAL REVIEW DATA</div></header>
    <table class="identity"><tbody>${rows.map((row) => `<tr>${row.map((value) => `<td dir="auto">${escapeHtml(value)}</td>`).join("")}</tr>`).join("")}</tbody></table>
    ${sections}<footer><div><p><strong>Reported by:</strong> Cedar Medical Center Laboratory</p>
    <p><strong>Prepared for finalization:</strong> ${date(finalizedAt)}</p><p><strong>Report version:</strong> ${version}</p></div>
    <img class="stamp" src="data:image/png;base64,${stamp}" alt="Cedar Medical Center Laboratory SAMPLE stamp · مركز سيدر الطبي"></footer>`,
      { waitUntil: "load", timeout: 10000 },
    );
    return Buffer.from(
      await page.pdf({
        format: "A4",
        printBackground: true,
        displayHeaderFooter: true,
        headerTemplate: "<span></span>",
        footerTemplate:
          '<div style="width:100%;text-align:center;font:10pt Arial">Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>',
        margin: { top: "14mm", right: "12mm", bottom: "17mm", left: "12mm" },
      }),
    );
  } finally {
    await browser.close();
  }
}
