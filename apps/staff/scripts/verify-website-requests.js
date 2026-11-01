// Intercepts external opening in this owned test process; never sends a message.
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { _electron as electron, chromium } from "playwright";
const folder = resolve(".local/website-requests-review");
await mkdir(folder, { recursive: true });
const access = JSON.parse(await readFile(folder + "/access.json", "utf8")),
  ready = JSON.parse(await readFile(folder + "/ready.json", "utf8"));
assert.equal(access.syntheticOnly, true);
assert.equal(ready.database, "capstone_staff_test");
const identity = await (
  await fetch("http://127.0.0.1:4101/__review/identity")
).json();
assert.equal(identity.database, "capstone_staff_test");
assert.equal(identity.ownedReview, true);
assert.equal(identity.pid, ready.pid);
const packageArg = process.argv.indexOf("--package"),
  exe = packageArg < 0 ? null : resolve(process.argv[packageArg + 1]);
let browser,
  desktop,
  stage = "launch",
  checks = 0;
const errors = [],
  external = [];
const pass = (s) => console.log(`PASS ${++checks}: ${s}`);
try {
  browser = await chromium.launch({ channel: "msedge" });
  const context = await browser.newContext({
    viewport: { width: 1400, height: 1000 },
  });
  await context.route("**/*", (route) => {
    const u = new URL(route.request().url());
    if (/^https?:$/.test(u.protocol) && u.origin !== "http://127.0.0.1:5191") {
      external.push(u.origin);
      return route.abort();
    }
    return route.continue();
  });
  const web = await context.newPage();
  web.on("pageerror", (e) => errors.push(e.message));
  stage = "public guest request";
  await web.goto("http://127.0.0.1:5191/request");
  await web.getByLabel("Session date", { exact: true }).fill(ready.date);
  await web
    .getByRole("combobox", { name: "Doctor or specialist", exact: true })
    .fill("Synthetic");
  await web.getByRole("option", { name: /Dr\. Synthetic Review/ }).click();
  await web.getByRole("radio").first().check();
  await web.getByRole("button", { name: "Continue", exact: true }).click();
  for (const [name, value] of [
    ["First name", "Website"],
    ["Father’s name", "Patientfather"],
    ["Last name", "Requestreview"],
    ["Mother’s maiden name", "Patientmother"],
    ["Date of birth", "2000-02-29"],
    ["Phone number", "71-123456"],
  ])
    await web.getByLabel(name, { exact: true }).fill(value);
  await web.getByLabel("Gender", { exact: true }).selectOption("female");
  await web
    .getByLabel("Preferred language", { exact: true })
    .selectOption("ar");
  await web.getByRole("button", { name: "متابعة", exact: true }).click();
  await web.getByRole("button", { name: "إرسال الطلب", exact: true }).click();
  await web
    .getByRole("heading", { name: "تم استلام الطلب", exact: true })
    .waitFor();
  const reference = await web
    .locator(".request-receipt strong")
    .first()
    .innerText();
  const link = await web
    .getByRole("textbox", { name: "احفظ هذا الرابط الخاص", exact: true })
    .inputValue();
  const tracking = await context.newPage();
  await tracking.goto(link);
  await tracking
    .getByText("بانتظار التأكيد", { exact: true })
    .first()
    .waitFor();
  assert.equal(
    (await tracking.locator("main").innerText()).includes("Patientmother"),
    false,
  );
  pass(
    "Real HTTP submission and private guest tracking persist, with Arabic preference and no submitted identity disclosure",
  );
  stage = "desktop sign-in";
  desktop = await electron.launch({
    ...(exe
      ? { executablePath: exe, args: ["--demo-loopback"] }
      : { args: [resolve("apps/staff"), "--demo-loopback"] }),
    env: { ...process.env, STAFF_API_URL: "http://127.0.0.1:4101" },
  });
  await desktop.evaluate(({ shell }) => {
    globalThis.reviewOpenCount = 0;
    shell.openExternal = async (url) => {
      const u = new URL(url);
      if (u.protocol !== "https:" || u.hostname !== "wa.me")
        throw Error("Unexpected external host");
      globalThis.reviewOpenCount++;
    };
  });
  const page = await desktop.firstWindow();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.getByLabel("Username", { exact: true }).fill(access.username);
  await page
    .getByLabel("Password or passphrase", { exact: true })
    .fill(access.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .getByRole("button", { name: "Website requests", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Website requests", exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Refresh requests", exact: true })
    .click();
  const open = page
    .getByRole("button", { name: `Review ${reference}`, exact: true })
    .first();
  await open.waitFor();
  await open.click();
  let dialog = page.getByRole("dialog");
  await dialog
    .getByRole("heading", { name: `Review ${reference}`, exact: true })
    .waitFor();
  pass(
    "Actual Electron bridge signs in synthetic clinic Receptionist and retrieves durable request inbox",
  );
  stage = "patient match and confirmation";
  await dialog
    .getByLabel("Private reason / discrepancy review", { exact: true })
    .fill("Synthetic review: this is a distinct patient, all fields checked");
  await dialog
    .getByLabel("I reviewed these candidates and discrepancies.", {
      exact: true,
    })
    .check();
  await dialog
    .getByRole("button", { name: "Create separate patient", exact: true })
    .click();
  await dialog
    .getByText(
      "Patient reviewed and linked. Registry details were not overwritten.",
      { exact: true },
    )
    .waitFor();
  await dialog
    .getByRole("button", { name: "Confirm request", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Confirm booking", exact: true })
    .click();
  await dialog.getByText("Confirmed", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page
    .getByRole("button", { name: "Refresh requests", exact: true })
    .click();
  await tracking.reload();
  await tracking.getByText("مؤكد", { exact: true }).first().waitFor();
  pass(
    "Registry-safe patient creation, authoritative booking and durable ordered public tracking work across APIs",
  );
  stage = "notice and intercepted external opening";
  await page
    .getByRole("button", { name: `Review ${reference}`, exact: true })
    .first()
    .click();
  dialog = page.getByRole("dialog");
  await dialog
    .getByRole("button", { name: "Send via WhatsApp", exact: true })
    .click();
  let notice = page.getByRole("dialog").last();
  await notice
    .getByLabel("Message language", { exact: true })
    .selectOption("ar");
  await notice.locator("pre strong").filter({ hasText: "مؤكد" }).waitFor();
  assert.equal(await notice.locator("pre strong").innerText(), "مؤكد");
  assert.equal(
    (await notice.locator("pre").innerText()).includes("Patientmother"),
    false,
  );
  await notice.getByLabel(/I checked the original submitted phone/).check();
  await notice
    .getByRole("button", { name: "Send via WhatsApp", exact: true })
    .click();
  await notice.getByText("WhatsApp link opened", { exact: true }).waitFor();
  assert.equal(await desktop.evaluate(() => globalThis.reviewOpenCount), 1);
  await notice
    .getByLabel("I manually sent this message in WhatsApp.", { exact: true })
    .check();
  await notice
    .getByRole("button", {
      name: "I manually sent it — mark sent",
      exact: true,
    })
    .click();
  await notice.getByText("Staff marked sent", { exact: true }).waitFor();
  await page.screenshot({ path: folder + "/packaged-notice.png" });
  await notice
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  pass(
    "Fixed Arabic notice uses ID-only main boundary; external opening intercepted and opened/sent history stay distinct",
  );
  stage = "rotation and cancellation";
  dialog = page.getByRole("dialog");
  await dialog
    .getByRole("button", { name: "Replace tracking link", exact: true })
    .click();
  await dialog
    .getByLabel("Reason", { exact: true })
    .fill(
      "Lost link: deliver replacement to original unverified submitted phone",
    );
  await dialog
    .getByLabel(
      "Replace the old link and send only to the original unverified submitted phone.",
      { exact: true },
    )
    .check();
  await dialog
    .getByRole("button", { name: "Confirm link replacement", exact: true })
    .click();
  await tracking.reload();
  await tracking
    .getByRole("alert")
    .filter({ hasText: /unavailable/ })
    .waitFor();
  await dialog
    .getByRole("button", { name: "Cancel linked booking", exact: true })
    .click();
  await dialog
    .getByLabel("Patient-facing reason", { exact: true })
    .selectOption("session_unavailable");
  await dialog
    .getByLabel("Private cancellation reason", { exact: true })
    .fill("Synthetic cancellation requested");
  await dialog
    .getByRole("button", { name: "Confirm cancellation", exact: true })
    .click();
  await dialog.getByText("Cancelled", { exact: true }).waitFor();
  pass(
    "Lost-link rotation invalidates old public link; fixed-reason cancellation preserves the booking record",
  );
  stage = "keyboard and narrow layout";
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  await page
    .getByRole("button", { name: `Review ${reference}`, exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("heading", { name: `Review ${reference}`, exact: true })
    .waitFor();
  for (let i = 0; i < 35; i++) {
    await page.keyboard.press("Tab");
    assert.equal(
      await page.evaluate(() =>
        [...document.querySelectorAll("[role=dialog]")]
          .at(-1)
          .contains(document.activeElement),
      ),
      true,
    );
  }
  await page.keyboard.press("Escape");
  assert.equal(await page.getByRole("dialog").count(), 0);
  await page.evaluate(() => window.resizeTo(560, 820));
  await page.waitForTimeout(300);
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await page.screenshot({ path: folder + "/packaged-inbox-narrow.png" });
  await web.goto("http://127.0.0.1:5191/request");
  await web.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await web.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    false,
  );
  await web.screenshot({
    path: folder + "/public-connected-mobile.png",
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  pass(
    "Native narrow layout and mobile website have no overflow, renderer runtime errors or unexpected external HTTP",
  );
  await writeFile(
    folder + (exe ? "/packaged-results.json" : "/development-results.json"),
    JSON.stringify(
      {
        checks,
        errors,
        external,
        packaged: Boolean(exe),
        syntheticTestOnly: true,
        externalOpeningMocked: true,
        realMessagesSent: 0,
      },
      null,
      2,
    ),
  );
} catch (e) {
  console.error(
    `FAIL at ${stage}: ${e.name}: ${e.message.replace(/#([A-Za-z0-9_-]{43})/g, "#[redacted]")}`,
  );
  for (const p of [
    desktop && (await desktop.firstWindow().catch(() => null)),
  ].filter(Boolean)) {
    await p.screenshot({ path: folder + "/failure.png" }).catch(() => {});
    await writeFile(
      folder + "/failure.txt",
      await p
        .locator("body")
        .innerText()
        .catch(() => ""),
    );
  }
  process.exitCode = 1;
} finally {
  await desktop?.close();
  await browser?.close();
}
