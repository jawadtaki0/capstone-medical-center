import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
const origin = "http://127.0.0.1:5190",
  folder = ".local/website-request-preview";
await mkdir(folder, { recursive: true });
let browser,
  context,
  stage = "browser launch",
  checks = 0;
const errors = [],
  forbidden = [];
const pass = (name) => {
  checks++;
  console.log(`PASS ${checks}: ${name}`);
};
try {
  browser = await chromium.launch({ channel: "msedge" });
  context = await browser.newContext({
    viewport: { width: 1440, height: 1050 },
  });
  context.on("page", (p) => {
    p.on("pageerror", (e) => errors.push(e.message));
    p.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
  });
  await context.route("**/*", (route) => {
    const u = new URL(route.request().url());
    if (
      (u.protocol === "http:" || u.protocol === "https:") &&
      (u.origin !== origin || u.pathname.startsWith("/api/"))
    ) {
      forbidden.push(u.origin + u.pathname);
      return route.abort();
    }
    return route.continue();
  });
  const pub = await context.newPage();
  pub.setDefaultTimeout(10000);
  await pub.goto(origin + "/request-preview.html");
  stage = "keyboard professional and session calendar";
  const combo = pub.getByRole("combobox", {
    name: "Doctor or specialist",
    exact: true,
  });
  await combo.fill("Cardiology");
  const professionalOption = pub
    .getByRole("listbox")
    .getByRole("option")
    .first();
  await professionalOption.hover();
  assert.notEqual(
    await professionalOption.evaluate((e) => getComputedStyle(e).boxShadow),
    "none",
  );
  await combo.press("Enter");
  await pub
    .getByRole("button", { name: "Open calendar: Session date", exact: true })
    .click();
  let dialog = pub.getByRole("dialog");
  await dialog.getByLabel("Month", { exact: true }).selectOption("10");
  await dialog.getByLabel("Year", { exact: true }).fill("2026");
  await dialog.getByRole("button", { name: "2026-11-02", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  await pub.getByRole("radio").check();
  assert.equal(await pub.getByText(/remaining of/i).count(), 0);
  await pub.getByRole("button", { name: "Continue", exact: true }).click();
  pass(
    "Searchable keyboard combobox and month/year calendar select a full session without private capacity",
  );
  stage = "required details, country phone and date";
  await pub.getByRole("button", { name: "Continue", exact: true }).click();
  await pub.getByRole("alert").filter({ hasText: "highlighted" }).waitFor();
  assert.equal(
    await pub
      .getByText("Enter your mother’s first name only.", { exact: true })
      .count(),
    0,
  );
  await pub
    .getByRole("button", { name: "Fill synthetic example", exact: true })
    .click();
  const country = pub.getByLabel("Phone country", { exact: true }),
    phone = pub.getByLabel("Phone number", { exact: true });
  assert.equal(
    await pub
      .getByLabel("Gender", { exact: true })
      .locator('option[value=""]')
      .isDisabled(),
    true,
  );
  await country.selectOption("LB");
  await phone.fill("03-123456");
  await country.selectOption("US");
  await phone.fill("202-555-0123");
  await phone.fill("+961 71 123 456");
  assert.equal(await country.inputValue(), "LB");
  await pub
    .getByRole("button", { name: "Open calendar: Date of birth", exact: true })
    .click();
  dialog = pub.getByRole("dialog");
  await dialog.getByLabel("Year", { exact: true }).fill("2000");
  await dialog.getByLabel("Month", { exact: true }).selectOption("1");
  await dialog.getByRole("button", { name: "2000-02-29", exact: true }).click();
  await pub.screenshot({
    path: folder + "/public-details-desktop.png",
    fullPage: true,
  });
  pass(
    "Required fields, no removed maternal helper, country switching/international paste and leap-day DOB",
  );
  stage = "Arabic review and preserved draft";
  await pub
    .getByLabel("Preferred language", { exact: true })
    .selectOption("ar");
  await pub.getByRole("button", { name: "متابعة", exact: true }).click();
  await pub.getByRole("heading", { name: "راجع طلبك", exact: true }).waitFor();
  await pub
    .getByRole("button", { name: "تعديل بيانات المريض", exact: true })
    .click();
  assert.equal(
    await pub.getByLabel("الاسم الأول", { exact: true }).inputValue(),
    "Synthetic",
  );
  await pub.getByRole("button", { name: "متابعة", exact: true }).click();
  await pub.screenshot({
    path: folder + "/public-review-arabic.png",
    fullPage: true,
  });
  await pub.getByRole("button", { name: "إرسال الطلب", exact: true }).click();
  await pub
    .getByRole("heading", { name: "تم استلام الطلب", exact: true })
    .waitFor();
  const link = await pub
    .getByRole("textbox", { name: "احفظ هذا الرابط الخاص", exact: true })
    .inputValue();
  const reference = await pub
    .locator(".request-receipt strong[dir=ltr]")
    .innerText();
  assert.ok(link.includes("#track/demo-not-a-secret-"));
  pass(
    "Arabic/RTL review preserves entered values and creates a clearly pending synthetic receipt",
  );
  stage = "tracking projection and Cedar refresh";
  const track = await context.newPage();
  track.setDefaultTimeout(10000);
  await track.goto(link);
  await track
    .getByRole("heading", { name: "متابعة طلبك", exact: true })
    .waitFor();
  const trackBody = await track.locator(".request-tracking").innerText();
  for (const v of [
    "Patientmother",
    "2000-02-29",
    "+96171123456",
    "Requestdemo",
  ])
    assert.equal(trackBody.includes(v), false, v);
  const cedar = await context.newPage();
  cedar.setDefaultTimeout(10000);
  await cedar.goto(origin + "/cedar-request-preview.html");
  await cedar.getByRole("button", { name: /Refresh requests/ }).click();
  await cedar
    .getByRole("button", { name: `Review ${reference}`, exact: true })
    .waitFor();
  await cedar
    .getByRole("button", { name: "Pause simulated tracking sync", exact: true })
    .click();
  await cedar
    .getByRole("button", { name: `Review ${reference}`, exact: true })
    .click();
  dialog = cedar.getByRole("dialog");
  await dialog.getByRole("radio").first().check();
  await dialog.getByLabel(/I compared all name fields/).check();
  await dialog
    .getByRole("button", { name: "Link reviewed patient", exact: true })
    .click();
  await dialog
    .getByLabel("Notes — never shown to the guest", { exact: true })
    .fill("PRIVATE-SYNTHETIC-NOTE-DO-NOT-PUBLISH");
  await dialog
    .getByRole("button", { name: "Save private note", exact: true })
    .click();
  pass(
    "Only allowlisted tracking fields appear; repeated synthetic retrieval and explicit patient-match acknowledgement work",
  );
  stage = "local confirmation with paused tracking delivery";
  await dialog
    .getByLabel("Preview confirmation result", { exact: true })
    .selectOption("unset");
  await dialog
    .getByRole("button", { name: "Confirm booking (preview)", exact: true })
    .click();
  await dialog
    .getByRole("alert")
    .filter({ hasText: "Not configured" })
    .waitFor();
  await dialog
    .getByLabel("Preview confirmation result", { exact: true })
    .selectOption("full");
  await dialog
    .getByRole("button", { name: "Confirm booking (preview)", exact: true })
    .click();
  await dialog
    .getByRole("alert")
    .filter({ hasText: "session is full" })
    .waitFor();
  await dialog
    .getByLabel("Preview confirmation result", { exact: true })
    .selectOption("available");
  await dialog
    .getByRole("button", { name: "Confirm booking (preview)", exact: true })
    .click();
  await dialog
    .getByRole("heading", { name: "Tracking delivery pending", exact: true })
    .count();
  await dialog
    .getByText("Tracking delivery pending", { exact: true })
    .waitFor();
  await track.getByText("بانتظار التأكيد", { exact: true }).first().waitFor();
  await dialog
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  await cedar
    .getByRole("button", {
      name: "Resume simulated tracking sync",
      exact: true,
    })
    .click();
  await cedar
    .getByRole("button", { name: `Review ${reference}`, exact: true })
    .click();
  dialog = cedar.getByRole("dialog");
  await dialog
    .getByRole("button", { name: "Retry simulated status sync", exact: true })
    .click();
  await track.getByText("مؤكد", { exact: true }).first().waitFor();
  assert.equal(
    (await track.locator(".request-tracking").innerText()).includes(
      "PRIVATE-SYNTHETIC",
    ),
    false,
  );
  pass(
    "Null/full illustrations block decisions; a local mock confirmation remains while public tracking stays at last sync",
  );
  stage = "manual WhatsApp without external opening";
  await dialog
    .getByRole("button", { name: "Send via WhatsApp", exact: true })
    .click();
  let notice = cedar.getByRole("dialog").last();
  await notice.getByRole("heading", { name: /Manual WhatsApp/ }).waitFor();
  const message = await notice.locator("pre").innerText();
  for (const v of [
    "2000-02-29",
    "Patientmother",
    "P-DEMO",
    "PRIVATE-SYNTHETIC",
  ])
    assert.equal(message.includes(v), false, v);
  assert.ok(message.includes("تسجيل الحضور"));
  assert.equal(await notice.locator("pre strong").innerText(), "مؤكد");
  assert.ok(message.includes("مركز سيدر للخدمات الطبية CMC"));
  await notice
    .getByRole("button", { name: "Simulate opening failure", exact: true })
    .click();
  await notice
    .getByRole("alert")
    .filter({ hasText: "Nothing was marked" })
    .waitFor();
  await notice
    .getByRole("button", { name: "Simulate WhatsApp link opened", exact: true })
    .click();
  await notice.getByLabel(/I manually sent/).check();
  await notice.getByRole("button", { name: "Mark sent", exact: true }).click();
  await notice
    .getByText("Staff marked sent", { exact: true })
    .first()
    .waitFor();
  await notice.screenshot({ path: folder + "/manual-message-arabic.png" });
  await notice
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  pass(
    "Arabic fixed manual notice, open failure, opened-versus-sent distinction and no actual external opening",
  );
  stage = "fixed cancellation, timeline and retained notice history";
  dialog = cedar.getByRole("dialog");
  await dialog
    .getByRole("button", { name: "Cancel linked booking", exact: true })
    .click();
  await dialog
    .getByLabel("Patient-facing reason", { exact: true })
    .selectOption("session_unavailable");
  await dialog
    .getByRole("button", { name: "Confirm cancellation", exact: true })
    .click();
  await track.getByText("ملغى", { exact: true }).first().waitFor();
  await track.getByText("الجلسة غير متاحة", { exact: true }).first().waitFor();
  await track.screenshot({
    path: folder + "/tracking-arabic.png",
    fullPage: true,
  });
  await dialog
    .getByRole("button", { name: "View notice history", exact: true })
    .click();
  notice = cedar.getByRole("dialog").last();
  assert.equal(
    await notice
      .getByRole("button", {
        name: "Simulate WhatsApp link opened",
        exact: true,
      })
      .isDisabled(),
    true,
  );
  await notice
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  await cedar
    .getByRole("dialog")
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  pass(
    "Fixed cancellation updates tracking; sent/opened history remains and stale notices cannot be used",
  );
  stage = "responsive, denial, empty and unavailable screens";
  await cedar.screenshot({
    path: folder + "/cedar-inbox-desktop.png",
    fullPage: true,
  });
  await cedar.setViewportSize({ width: 390, height: 844 });
  await cedar.screenshot({
    path: folder + "/cedar-inbox-mobile.png",
    fullPage: true,
  });
  assert.equal(
    await cedar.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await cedar
    .getByLabel("Preview role", { exact: true })
    .selectOption("Clinic Admin");
  await cedar
    .getByRole("heading", {
      name: "Clinic request access unavailable",
      exact: true,
    })
    .waitFor();
  assert.equal(
    (await cedar.locator("body").innerText()).includes("Requestdemo"),
    false,
  );
  await cedar
    .getByLabel("Preview role", { exact: true })
    .selectOption("Receptionist");
  await cedar
    .getByLabel("Synthetic clinic assignment", { exact: true })
    .uncheck();
  await cedar
    .getByRole("heading", {
      name: "Clinic request access unavailable",
      exact: true,
    })
    .waitFor();
  await cedar
    .getByLabel("Synthetic clinic assignment", { exact: true })
    .check();
  await cedar
    .getByLabel("Preview state", { exact: true })
    .selectOption("empty");
  await cedar
    .getByRole("heading", { name: "No requests found", exact: true })
    .waitFor();
  await cedar
    .getByLabel("Preview state", { exact: true })
    .selectOption("unavailable");
  await cedar
    .getByRole("heading", { name: "Request inbox unavailable", exact: true })
    .waitFor();
  await track.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await track.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await track.screenshot({
    path: folder + "/tracking-arabic-mobile.png",
    fullPage: true,
  });
  await pub.goto(origin + "/request-preview.html");
  await pub.setViewportSize({ width: 390, height: 844 });
  await pub
    .getByLabel("Website preview language", { exact: true })
    .selectOption("ar");
  assert.equal(
    await pub.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    false,
  );
  await pub.screenshot({
    path: folder + "/public-mobile-arabic.png",
    fullPage: true,
  });
  pass(
    "Mobile inbox/cards, Arabic tracking, denied roles/scopes, empty/error screens and no horizontal overflow",
  );
  stage = "dialog keyboard and focus restoration";
  const keyboard = await context.newPage();
  await keyboard.goto(origin + "/cedar-request-preview.html");
  const opener = keyboard.getByRole("button", {
    name: "Review WR-DEMO-0001",
    exact: true,
  });
  await opener.click();
  for (let i = 0; i < 35; i++) {
    await keyboard.keyboard.press("Tab");
    assert.equal(
      await keyboard.evaluate(() =>
        document.querySelector("dialog[open]").contains(document.activeElement),
      ),
      true,
    );
  }
  await keyboard.keyboard.press("Escape");
  assert.equal(await keyboard.getByRole("dialog").count(), 0);
  assert.equal(
    await opener.evaluate((e) => e === document.activeElement),
    true,
  );
  await keyboard.goto(origin + "/request-preview.html");
  const calendarOpener = keyboard.getByRole("button", {
    name: "Open calendar: Session date",
    exact: true,
  });
  await calendarOpener.click();
  await keyboard.keyboard.press("Escape");
  assert.equal(await keyboard.getByRole("dialog").count(), 0);
  assert.equal(
    await calendarOpener.evaluate((e) => e === document.activeElement),
    true,
  );
  pass("Dialog Tab containment, Escape cancellation and focus restoration");
  stage = "reduced motion and safe boundary";
  const reduced = await context.newPage();
  await reduced.emulateMedia({ reducedMotion: "reduce" });
  await reduced.goto(origin + "/request-preview.html");
  await reduced
    .getByRole("heading", { name: "Request a clinic session", exact: true })
    .waitFor();
  assert.equal(await reduced.locator(".grainient-backdrop canvas").count(), 0);
  assert.deepEqual(forbidden, []);
  assert.deepEqual(errors, []);
  pass(
    "Reduced-motion fallback and no console errors, normal API calls, third-party requests or provider openings",
  );
  await writeFile(
    folder + "/browser-results.json",
    JSON.stringify(
      {
        checks,
        errors,
        forbidden,
        mockedOnly: true,
        normalBackendIntegration: false,
      },
      null,
      2,
    ),
  );
} catch (e) {
  console.error(`FAIL at ${stage}: ${e.stack}`);
  for (const [i, p] of (context?.pages() ?? []).entries()) {
    await p
      .screenshot({ path: folder + `/failure-${i}.png`, fullPage: true })
      .catch(() => {});
    await writeFile(
      folder + `/failure-${i}.txt`,
      await p
        .locator("body")
        .innerText()
        .catch(() => ""),
    );
  }
  process.exitCode = 1;
} finally {
  await browser?.close();
}
