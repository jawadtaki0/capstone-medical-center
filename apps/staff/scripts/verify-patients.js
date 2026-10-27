import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { resolve, relative, isAbsolute, sep } from "node:path";
import { mkdir, open, unlink, access, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { _electron as electron } from "playwright";
import { readLauncherConfig } from "../../staff-api/scripts/launcher/configuration.js";
import { PATIENT_LABELS, PATIENT_ROLES } from "../shared/patient-input.js";

// Explicit guarded TEST harness. Never calls bootstrap, SMTP, normal APIs or
// launcher selection. Refuses an occupied review port and concurrent harness.
const args = process.argv.slice(2),
  interactive = args.includes("--interactive"),
  index = args.indexOf("--package"),
  executable = index < 0 ? undefined : resolve(args[index + 1]),
  roleIndex = args.indexOf("--role"),
  role = roleIndex < 0 ? "Receptionist" : args[roleIndex + 1];
assert.ok(PATIENT_ROLES.includes(role));
if (executable) {
  const path = relative(resolve("apps/staff/release"), executable);
  assert.ok(
    path &&
      !path.startsWith(`..${sep}`) &&
      !isAbsolute(path) &&
      path.endsWith(".exe"),
  );
  await access(executable);
}
await access(resolve("apps/staff/dist/index.html"));
const lockPath = resolve(".local/professional-schedule-review/review.lock"),
  evidence = resolve(".local/patient-registry-review"),
  errors = [],
  external = [];
let lock,
  fixture,
  proxy,
  client,
  page,
  unavailable = false,
  delayCheck,
  checkCalls = 0,
  saveCalls = 0,
  stage = "review lock",
  checks = 0;
const pass = (label) => {
  checks++;
  console.log(`PASS ${checks}: ${label}`);
};
const sample = {
  firstName: "Synthetic",
  fatherName: "Patientfather",
  lastName: "Registryexample",
  motherFirstName: "Patientmother",
  dateOfBirth: "2000-02-29",
  phone: "+96171123456",
  gender: "female",
};
async function pauseForReview() {
  console.log(
    `SYNTHETIC TEST ONLY — signed in as ${role}. Normal records and selected shortcut are untouched. Press Enter here to finish and clear only TEST fixtures.`,
  );
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    await once(rl, "line");
  } finally {
    rl.close();
  }
}
try {
  await mkdir(resolve(".local/professional-schedule-review"), {
    recursive: true,
  });
  await mkdir(evidence, { recursive: true });
  lock = await open(lockPath, "wx");
  await lock.writeFile(
    JSON.stringify({
      pid: process.pid,
      kind: "patient-registry-synthetic-review",
    }),
  );
  stage = "owned TEST port";
  proxy = createServer(async (req, res) => {
    try {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 16384) throw Error("Oversize TEST payload");
        chunks.push(chunk);
      }
      if (req.url === "/patients/check") {
        checkCalls++;
        if (delayCheck) await delayCheck;
      }
      if (["/patients/create", "/patients/update"].includes(req.url))
        saveCalls++;
      if (unavailable || !fixture) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              code: "authority_unavailable",
              message: "Owned TEST authority unavailable.",
            },
          }),
        );
        return;
      }
      const response = await fixture.request(req.url, {
        method: req.method,
        token: req.headers.authorization?.replace(/^Bearer /, ""),
        ...(bytes
          ? { body: JSON.parse(Buffer.concat(chunks).toString()) }
          : {}),
        originHeader: req.headers.origin ?? "app://staff",
      });
      res.writeHead(response.status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(response.body));
    } catch {
      if (!res.headersSent)
        res.writeHead(503, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            code: "authority_unavailable",
            message: "Owned TEST authority unavailable.",
          },
        }),
      );
    }
  });
  proxy.listen(4101, "127.0.0.1");
  await once(proxy, "listening");
  stage = "guarded TEST fixture";
  process.env.CAPSTONE_STAFF_RUNTIME_DIR = (
    await readLauncherConfig()
  ).runtimeDirectory;
  const { createSecurityFixture } =
    await import("../../staff-api/test/helpers/security-fixture.js");
  fixture = await createSecurityFixture();
  await fixture.reset();
  const actor = await fixture.account({
    roles: [role],
    mfa: role !== "Receptionist",
    username: "synthetic.patient.review",
  });
  stage = "desktop launch";
  client = await electron.launch({
    ...(executable
      ? { executablePath: executable, args: ["--demo-loopback"] }
      : { args: [resolve("apps/staff"), "--demo-loopback"] }),
    env: { ...process.env, STAFF_API_URL: "http://127.0.0.1:4101" },
    timeout: 30000,
  });
  page = await client.firstWindow();
  page.setDefaultTimeout(15000);
  page.on("pageerror", () => errors.push("renderer exception"));
  page.on("console", (m) => {
    if (m.type() === "error" || /Electron Security Warning/.test(m.text()))
      errors.push("console/security error");
  });
  page.on("request", (r) => {
    if (!r.url().startsWith("app://staff/"))
      external.push(new URL(r.url()).protocol);
  });
  await page.getByLabel("Username", { exact: true }).fill(actor.username);
  await page
    .getByLabel("Password or passphrase", { exact: true })
    .fill(actor.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  if (actor.secret) {
    await page
      .getByLabel("Authenticator code", { exact: true })
      .fill(await fixture.totp(actor.secret));
    await page
      .getByRole("button", { name: "Verify and continue", exact: true })
      .click();
  }
  if (role === "Admin" && !interactive) {
    await page
      .getByRole("button", { name: "Staff Directory", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Create staff account", exact: true })
      .click();
    const form = page.locator("form").filter({
      has: page.getByRole("heading", {
        name: "Create an individual account and profile",
        exact: true,
      }),
    });
    await form.getByLabel("Phone country", { exact: true }).selectOption("US");
    await form.getByLabel("Phone", { exact: true }).fill("202-555-0123");
    assert.equal(
      await form.locator('input[name="phone"]').inputValue(),
      "+12025550123",
    );
    await form
      .getByRole("button", { name: "Cancel creation", exact: true })
      .click();
    pass(
      "Existing staff-registration country selector still formats correctly without creating an account",
    );
  }
  await page.getByRole("button", { name: "Patients", exact: true }).click();
  await page.getByRole("heading", { name: "Patients", exact: true }).waitFor();
  pass(
    "Real authenticated desktop bridge opens shared patient registry without scope grants",
  );
  if (interactive) {
    await pauseForReview();
  } else {
    stage = "search before creation";
    assert.equal(
      await page
        .getByRole("button", { name: "Register new patient", exact: true })
        .count(),
      0,
    );
    await page
      .getByRole("button", { name: "Search patients", exact: true })
      .click();
    await page
      .getByRole("alert")
      .filter({ hasText: "Enter at least one" })
      .waitFor();
    await page.getByLabel("First name", { exact: true }).fill("Synthetic");
    await page
      .getByRole("button", { name: "Search patients", exact: true })
      .click();
    await page
      .getByText("No matching patients found.", { exact: false })
      .waitFor();
    await page
      .getByRole("button", { name: "Register new patient", exact: true })
      .click();
    let dialog = page.getByRole("dialog");
    assert.equal(
      await dialog
        .getByText("Enter your mother’s first name only.", { exact: true })
        .count(),
      0,
    );
    const phoneCountry = dialog.getByLabel("Phone country", { exact: true }),
      phoneField = dialog.getByLabel("Phone number", { exact: true });
    assert.equal(await phoneCountry.inputValue(), "LB");
    const aligned = async () => {
      const phone = await phoneField.boundingBox(),
        gender = await dialog
          .getByLabel("Gender", { exact: true })
          .boundingBox();
      assert.ok(
        Math.abs(phone.y - gender.y) < 2,
        "Phone and Gender input tops must align",
      );
    };
    await aligned();
    for (const [country, raw, expected] of [
      ["LB", "71-123456", "+96171123456"],
      ["LB", "71-123 456", "+96171123456"],
      ["LB", "03-123456", "+9613123456"],
      ["US", "202-555-0123", "+12025550123"],
      ["GB", "020-7946 0018", "+442079460018"],
    ]) {
      await phoneCountry.selectOption(country);
      await phoneField.fill(raw);
      assert.equal(
        await dialog.locator('input[name="phone"]').inputValue(),
        expected,
      );
      await aligned();
    }
    await phoneCountry.selectOption("US");
    await phoneField.fill("71-123456");
    assert.equal(await phoneField.getAttribute("aria-invalid"), "true");
    await aligned();
    await phoneField.fill("+961 71 123 456");
    assert.equal(await phoneCountry.inputValue(), "LB");
    assert.equal(
      await dialog.locator('input[name="phone"]').inputValue(),
      "+96171123456",
    );
    await phoneCountry.selectOption("LB");
    await phoneField.fill("71-");
    await aligned();
    await phoneCountry.selectOption("LB");
    pass(
      "Country-aware national formats, leading zero, international paste and empty/invalid desktop alignment",
    );
    await dialog
      .getByRole("button", { name: "Check duplicates", exact: true })
      .click();
    await dialog
      .getByRole("alert")
      .filter({ hasText: "highlighted" })
      .waitFor();
    for (const [key, value] of Object.entries(sample)) {
      if (key === "gender")
        await dialog
          .getByLabel(PATIENT_LABELS[key], { exact: true })
          .selectOption(value);
      else
        await dialog
          .getByLabel(PATIENT_LABELS[key], { exact: true })
          .fill(value);
    }
    let releaseDouble;
    delayCheck = new Promise((resolve) => {
      releaseDouble = resolve;
    });
    const baselineCheck = checkCalls;
    await dialog
      .getByRole("button", { name: "Check duplicates", exact: true })
      .dblclick();
    releaseDouble();
    delayCheck = null;
    await dialog
      .getByText("No similar records found.", { exact: false })
      .waitFor();
    assert.equal(checkCalls, baselineCheck + 1);
    await dialog
      .getByRole("button", { name: "Register patient", exact: true })
      .click();
    await dialog.waitFor({ state: "detached" });
    await page
      .getByText("Patient P-00000001 saved.", { exact: true })
      .waitFor();
    pass(
      "Required field feedback, leading-zero DOB, single submission and persistent number allocation",
    );
    stage = "edit persistence";
    await page
      .getByRole("button", { name: "Open patient", exact: true })
      .click();
    dialog = page.getByRole("dialog");
    await dialog
      .getByLabel("Father’s name", { exact: true })
      .fill("Updatedfather");
    await dialog
      .getByRole("button", { name: "Check duplicates", exact: true })
      .click();
    await dialog
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await dialog.waitFor({ state: "detached" });
    assert.equal(
      (
        await fixture.db
          .collection("patients")
          .findOne({ patientNumber: "P-00000001" })
      ).fatherName,
      "Updatedfather",
    );
    pass("Edit persists in real TEST MongoDB with unchanged patient number");
    stage = "duplicate warning";
    await page
      .getByRole("button", { name: "Register new patient", exact: true })
      .click();
    dialog = page.getByRole("dialog");
    for (const [key, value] of Object.entries({
      ...sample,
      fatherName: "Updatedfather",
      dateOfBirth: "2001-02-28",
    })) {
      if (key === "gender")
        await dialog
          .getByLabel(PATIENT_LABELS[key], { exact: true })
          .selectOption(value);
      else
        await dialog
          .getByLabel(PATIENT_LABELS[key], { exact: true })
          .fill(value);
    }
    await dialog
      .getByRole("button", { name: "Check duplicates", exact: true })
      .click();
    await dialog
      .getByText("Date discrepancy: entered 2001-02-28; existing 2000-02-29.", {
        exact: true,
      })
      .waitFor();
    await dialog
      .getByRole("button", { name: "Register patient", exact: true })
      .click();
    await dialog
      .getByRole("alert")
      .filter({ hasText: "Acknowledge" })
      .waitFor();
    await dialog
      .getByLabel("I compared the possible matches", { exact: false })
      .check();
    await dialog
      .getByLabel("Reason for continuing with this patient record", {
        exact: true,
      })
      .fill("Synthetic distinct family member reviewed");
    await dialog
      .getByRole("button", { name: "Register patient", exact: true })
      .click();
    await dialog.waitFor({ state: "detached" });
    assert.equal(await fixture.db.collection("patients").countDocuments(), 2);
    pass(
      "Possible duplicate dates and supporting shared phone; explicit acknowledgement/reason before distinct registration",
    );
    stage = "narrow and keyboard";
    await client.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setSize(390, 760),
    );
    await page
      .getByRole("button", { name: "Open patient", exact: true })
      .click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel("First name", { exact: true }).waitFor();
    assert.equal(
      await dialog.evaluate((el) => el.contains(document.activeElement)),
      true,
    );
    await dialog.getByRole("button", { name: "Cancel", exact: true }).focus();
    await page.keyboard.press("Tab");
    assert.equal(
      await dialog
        .getByLabel("First name", { exact: true })
        .evaluate((el) => el === document.activeElement),
      true,
    );
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    await page.screenshot({
      path: resolve(
        evidence,
        executable ? "packaged-narrow.png" : "development-narrow.png",
      ),
    });
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    assert.equal(
      await page
        .getByRole("button", { name: "Open patient", exact: true })
        .evaluate((el) => el === document.activeElement),
      true,
    );
    pass(
      "390px layout without overflow, dialog Tab trap, Escape and focus restoration",
    );
    stage = "stale edit";
    await page
      .getByRole("button", { name: "Open patient", exact: true })
      .click();
    dialog = page.getByRole("dialog");
    await dialog
      .getByLabel("Father’s name", { exact: true })
      .fill("Stalefather");
    await dialog
      .getByRole("button", { name: "Check duplicates", exact: true })
      .click();
    await dialog
      .getByRole("heading", { name: "Duplicate review", exact: true })
      .waitFor();
    const target = await fixture.db
      .collection("patients")
      .findOne({ patientNumber: "P-00000002" });
    await fixture.db
      .collection("patients")
      .updateOne({ _id: target._id }, { $inc: { revision: 1 } });
    await dialog
      .getByLabel("I compared the possible matches", { exact: false })
      .check();
    await dialog
      .getByLabel("Reason for continuing with this patient record", {
        exact: true,
      })
      .fill("Synthetic edited family member");
    await dialog
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await dialog.getByRole("alert").filter({ hasText: "Reload it" }).waitFor();
    assert.equal(
      (await fixture.db.collection("patients").findOne({ _id: target._id }))
        .fatherName,
      "Updatedfather",
    );
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await dialog
      .getByRole("button", { name: "Discard changes", exact: true })
      .click();
    pass(
      "Stale edits reject without overwrite; explicit discard preserves saved fields",
    );
    stage = "delayed response/access expiry";
    await page
      .getByRole("button", { name: "Open patient", exact: true })
      .click();
    dialog = page.getByRole("dialog");
    let release;
    delayCheck = new Promise((resolve) => {
      release = resolve;
    });
    await dialog
      .getByRole("button", { name: "Check duplicates", exact: true })
      .click();
    await page.waitForTimeout(150);
    fixture.advance(11 * 60000);
    release();
    delayCheck = null;
    await page
      .getByRole("heading", { name: "Sign in to Cedar Staff", exact: true })
      .waitFor();
    assert.equal(await page.getByRole("dialog").count(), 0);
    pass(
      "Delayed duplicate response after real authorization expiry cannot restore patient editor",
    );
    stage = "owned TEST outage";
    unavailable = true;
    await page.getByLabel("Username", { exact: true }).fill(actor.username);
    await page
      .getByLabel("Password or passphrase", { exact: true })
      .fill(actor.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page
      .getByRole("heading", {
        name: "Local staff server unavailable",
        exact: true,
      })
      .waitFor();
    assert.equal(await page.getByRole("dialog").count(), 0);
    unavailable = false;
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    await page
      .getByRole("heading", { name: "Sign in to Cedar Staff", exact: true })
      .waitFor();
    pass(
      "Owned TEST API outage fails closed and recovers without touching shared services",
    );
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    pass(
      "No observed renderer/runtime/security errors or external renderer requests",
    );
    await writeFile(
      resolve(
        evidence,
        executable ? "packaged-results.json" : "development-results.json",
      ),
      JSON.stringify(
        {
          mode: executable ? "packaged" : "development",
          checks,
          errors,
          external,
          checkCalls,
          saveCalls,
          role,
          at: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
  }
} catch (error) {
  if (page) {
    await page
      .screenshot({ path: resolve(evidence, "failure-v2.png") })
      .catch(() => {});
    await writeFile(
      resolve(evidence, "failure-v2.txt"),
      await page
        .locator("body")
        .innerText()
        .catch(() => "TEST renderer unavailable"),
    ).catch(() => {});
  }
  console.error(`FAIL at ${stage}: ${error.name}: ${error.message}`);
  process.exitCode = 1;
} finally {
  await client?.close().catch(() => {});
  if (proxy) {
    proxy.closeAllConnections();
    await new Promise((resolve) => proxy.close(resolve));
  }
  if (fixture) {
    await fixture.reset();
    await fixture.close();
  }
  if (lock) {
    await lock.close();
    await unlink(lockPath);
  }
}
