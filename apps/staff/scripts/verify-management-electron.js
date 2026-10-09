import assert from "node:assert/strict";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import argon2 from "argon2";
import { _electron as electron } from "playwright";
import { generate, generateSecret } from "otplib";
import { createApp } from "../../staff-api/src/app.js";
import {
  createGmailDelivery,
  safeDeliveryError,
} from "../../staff-api/src/contact-delivery.js";
import { connectStaffDatabase } from "../../staff-api/src/db.js";
import { createVault } from "../../staff-api/src/local-security.js";
import {
  assertIsolatedTestTarget,
  STAFF_COLLECTIONS,
  syntheticProfile,
} from "../../staff-api/test/helpers/security-fixture.js";

// This destructive fixture runner is deliberately restricted to TEST, never DEV.
// Run it alone: the security/lifecycle suites share the same isolated database.
// Credentials, factors, setup codes and secret-bearing screens stay in memory.
const directory = dirname(fileURLToPath(import.meta.url));
const applicationPath = resolve(directory, "..");
const packaged = process.argv.includes("--packaged");
const executablePath = packaged
  ? join(
      applicationPath,
      "release",
      ...(process.argv.includes("--contact-ownership-review-package")
        ? ["staff-management-contact-ownership-review"]
        : process.argv.includes("--self-service-email-review-package")
          ? ["staff-management-self-service-email-review"]
          : process.argv.includes("--same-email-review-package")
            ? ["staff-management-same-email-review"]
            : process.argv.includes("--final-review-package")
              ? ["staff-management-final-review"]
              : process.argv.includes("--profile-email-modal-package")
                ? ["profile-email-modal-review"]
                : process.argv.includes("--email-review-package")
                  ? ["email-review"]
                  : process.argv.includes("--contact-gate-package")
                    ? ["contact-gate-review"]
                    : process.argv.includes("--work-details-package")
                      ? ["work-details-review"]
                      : process.argv.includes("--review-package")
                        ? ["management-review"]
                        : []),
      "win-unpacked",
      "Cedar Staff Development.exe",
    )
  : undefined;
const evidence = resolve(directory, "../../../.local/staff-management-review");
const prefix = packaged ? "packaged-" : "";
const origin = "http://127.0.0.1:4101";
const digest = (value) => createHash("sha256").update(value).digest("hex");
const suffix = randomBytes(5).toString("hex");
const actor = {
  id: `synthetic:${randomUUID()}`,
  username: `review.long.username.admin.${suffix}`,
  password: `Synthetic management ${randomBytes(24).toString("base64url")}`,
};
const employee = {
  username: `review.reception.${suffix}`,
  password: `Synthetic reception ${randomBytes(24).toString("base64url")}`,
};
const actorProfile = syntheticProfile({
  firstName: "Synthetic",
  lastName: "Manager",
  qualification: {
    type: "university",
    level: "Bachelor",
    title: "Synthetic relevant management degree",
    institution: "Synthetic review university",
  },
});
const employeeProfile = syntheticProfile({
  firstName: "Synthetic",
  lastName: "Reception",
  departments: ["Clinic"],
  qualification: {
    type: "university",
    level: "Bachelor",
    title: "Synthetic relevant qualification",
    institution: "Synthetic review university",
  },
});
let connection, vault, server, client, page;
let stage = "guarded test fixture";
let clockOffset = 0;
let employeeSetupCode;
let actorBackupCodes = [];
const errors = [],
  rendererRequests = [];
const mainRequests = [];
const serverFailureCodes = [];
const clock = () => new Date(Date.now() + clockOffset);
let contactReady = false,
  contactFailure = false;
let cancelFailure = false;
let expiryResponse = false;
const contactMessages = [];
const contactDelivery = {
  email: {
    mode: "test",
    provider: "gmail",
    async configuration(destination) {
      if (!contactReady)
        throw safeDeliveryError({ code: "contact_delivery_disabled" });
      await createGmailDelivery({
        load: async () => ({
          version: 2,
          deliveryScope: "staff_self_service",
          provider: "gmail",
          sender: "synthetic.sender@gmail.com",
          appPassword: "SyntheticOnly123",
          enabled: true,
          allowance: 20,
          approvalId: "11111111-1111-1111-1111-111111111111",
        }),
        transport() {
          throw new Error("No native TEST SMTP transport is permitted");
        },
      }).configuration(destination);
      return { approvalId: "synthetic-native-review", allowance: 20 };
    },
    async send(message) {
      contactMessages.push(message);
      if (contactFailure) throw new Error("Synthetic delivery unavailable");
    },
  },
};

function pass(name) {
  console.log(
    `PASS: ${packaged ? "packaged" : "development"} management ${name}`,
  );
}
async function startServer() {
  assertIsolatedTestTarget(connection);
  const app = createApp({
    ...connection,
    vault,
    clock,
    demoMode: true,
    contactDelivery,
  });
  server = createServer((request, response) => {
    const originalEnd = response.end.bind(response);
    response.end = (chunk, ...args) => {
      try {
        const code = JSON.parse(String(chunk)).error?.code;
        if (typeof code === "string" && /^[a-z_]+$/.test(code))
          serverFailureCodes.push(code);
      } catch {
        /* No body/secret details retained. */
      }
      return originalEnd(chunk, ...args);
    };
    if (cancelFailure && request.url === "/contacts/cancel") {
      response.writeHead(503, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          error: {
            code: "authority_unavailable",
            message:
              "Synthetic cancellation unavailable. Retry without closing.",
          },
        }),
      );
    } else {
      if (expiryResponse && request.url === "/contacts/status") {
        // Exercise only the UI expiry hint with a synthetic expired response;
        // actual server expiry/replay is covered by the guarded API tests.
        const end = response.end.bind(response);
        response.end = (chunk, ...args) => {
          const payload = JSON.parse(String(chunk));
          if (payload.pending)
            payload.pending.expiresAt = new Date(
              Date.now() - 1000,
            ).toISOString();
          return end(JSON.stringify(payload), ...args);
        };
      }
      app(request, response);
    }
  }).listen(4101, "127.0.0.1");
  await once(server, "listening");
}
async function stopServer() {
  const owned = server;
  server = undefined;
  if (owned) {
    owned.closeAllConnections();
    await new Promise((resolve) => owned.close(resolve));
  }
}
async function closeClient() {
  if (!client) return;
  // Node's fetch diagnostics expose URLs, not request bodies/headers. Retain only
  // origin and query-free paths in memory; no URL or private field is printed.
  const recorded = await client
    .evaluate(() => globalThis.__staffManagementReviewRequests ?? [])
    .catch(() => []);
  mainRequests.push(...recorded);
  await client.close();
  client = undefined;
  page = undefined;
}
async function launch() {
  client = await electron.launch({
    ...(executablePath
      ? { executablePath, args: ["--demo-loopback"] }
      : { args: [applicationPath, "--demo-loopback"] }),
    env: { ...process.env, STAFF_API_URL: origin },
    timeout: 30000,
  });
  await client.evaluate(() => {
    const diagnostics = process.getBuiltinModule("diagnostics_channel");
    globalThis.__staffManagementReviewRequests = [];
    diagnostics.channel("undici:request:create").subscribe((message) => {
      globalThis.__staffManagementReviewRequests.push({
        origin: String(message.request.origin),
        path: String(message.request.path).split("?")[0],
      });
    });
  });
  page = await client.firstWindow();
  page.on("pageerror", (error) =>
    errors.push({
      kind: "renderer-error",
      name: /^[A-Za-z]+Error$/.test(error.name) ? error.name : "Error",
    }),
  );
  page.on("console", (message) => {
    if (
      message.type() !== "error" &&
      !/Electron Security Warning/.test(message.text())
    )
      return;
    const text = message.text();
    // Classify common runtime diagnostics without recording their raw text,
    // which could include private forms or authentication values.
    const kind = /Electron Security Warning/.test(text)
      ? "electron-security"
      : /Cannot update a component/.test(text)
        ? "react-cross-render-update"
        : /controlled|uncontrolled/.test(text)
          ? "react-input-control"
          : /[Pp]attern attribute|not a valid regular expression/.test(text)
            ? "invalid-input-pattern"
            : /Invalid DOM property/.test(text)
              ? "invalid-dom-property"
              : /value.*prop.*onChange/.test(text)
                ? "read-only-input-value"
                : /final argument.*useEffect/i.test(text)
                  ? "react-effect-dependencies"
                  : /maximum update depth/i.test(text)
                    ? "react-update-depth"
                    : /unique.*key/i.test(text)
                      ? "react-key"
                      : /blocked.*aria-hidden|aria-hidden.*blocked/i.test(text)
                        ? "focus-aria-hidden"
                        : /Failed to load resource/.test(text)
                          ? "resource-load"
                          : "unclassified-console-error";
    errors.push({ kind, stage });
  });
  page.on("request", (request) => {
    if (/^https?:/.test(request.url()))
      rendererRequests.push("renderer-network-attempt");
  });
  await page
    .getByRole("heading", { name: "Sign in to Cedar Staff", exact: true })
    .waitFor();
  assert.equal(
    await page.evaluate(() => Object.keys(window.staffApi).length),
    31,
  );
  assert.equal(await page.evaluate(() => typeof window.require), "undefined");
}
async function dimensions(width, height = 800) {
  await client.evaluate(
    ({ BrowserWindow }, size) =>
      BrowserWindow.getAllWindows()[0].setSize(size.width, size.height),
    { width, height },
  );
  await page.waitForTimeout(200);
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    ),
    false,
  );
}
async function safeScreenshot(name, emailModal = false) {
  // A screenshot is allowed only after all private handoff/enrollment/factor
  // screens are absent and every password-type input is empty.
  const safe = await page.evaluate(
    (allowEmail) =>
      !document.querySelector(
        `.staff-private-handoff, .staff-backup-codes, .staff-qr, .staff-private-key, ${allowEmail ? ".staff-verification-dialog:not(.staff-email-dialog)" : ".staff-verification-dialog"}`,
      ) &&
      ![
        ...document.querySelectorAll(
          'input[type="password"], .staff-email-dialog input[name="code"]',
        ),
      ].some((input) => input.value),
    emailModal,
  );
  assert.equal(safe, true);
  // Normalize scroll position so full-page captures do not relocate an
  // off-screen fixed skip link into the middle of the screenshot.
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: join(evidence, `${prefix}${name}.png`),
    fullPage: true,
  });
}
async function totp(username) {
  const account = await connection.db
    .collection("accounts")
    .findOne({ username });
  const currentStep = Math.floor(clock().getTime() / 30000);
  if (account.mfa?.lastAcceptedStep >= currentStep)
    clockOffset += (account.mfa.lastAcceptedStep - currentStep + 1) * 30000;
  const secret = vault.decrypt(
    account.pendingMfaSecretCipher || account.mfa.secretCipher,
  );
  return generate({
    secret,
    epoch: Math.floor(clock().getTime() / 1000),
    period: 30,
    digits: 6,
  });
}
async function signIn(person, withMfa = false) {
  await page.getByLabel("Username", { exact: true }).fill(person.username);
  await page
    .getByLabel("Password or passphrase", { exact: true })
    .fill(person.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  if (withMfa) {
    await page
      .getByRole("heading", {
        name: "Enter your authenticator code",
        exact: true,
      })
      .waitFor();
    await page
      .getByLabel("Authenticator code", { exact: true })
      .fill(await totp(person.username));
    await page
      .getByRole("button", { name: "Verify and continue", exact: true })
      .click();
  }
}
async function signOut() {
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page
    .getByRole("heading", { name: "Sign in to Cedar Staff", exact: true })
    .waitFor();
  assert.equal(await page.locator(".staff-signed-in").count(), 0);
}
async function openDirectory() {
  await page
    .getByRole("button", { name: "Staff Directory", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Staff directory", exact: true })
    .waitFor();
  await page.getByLabel("Search staff", { exact: true }).waitFor();
  assert.equal(
    await page
      .getByRole("heading", { name: "Staff directory", exact: true })
      .evaluate((element) => element === document.activeElement),
    true,
  );
}
async function openEmployee() {
  await page
    .getByRole("button", {
      name: `View profile for ${employeeProfile.firstName} ${employeeProfile.lastName}`,
      exact: true,
    })
    .click();
  await page
    .getByRole("button", { name: "Edit this staff profile", exact: true })
    .waitFor();
}
async function handoff() {
  await page
    .getByRole("heading", {
      name: "Privately hand over this setup code",
      exact: true,
    })
    .waitFor();
  employeeSetupCode = (
    await page
      .locator(".staff-private-handoff .staff-private-key")
      .textContent()
  ).trim();
  assert.equal(employeeSetupCode.length > 10, true);
  await page
    .getByRole("button", { name: "Close private handoff", exact: true })
    .click();
  await page.locator(".staff-private-handoff").waitFor({ state: "hidden" });
}
async function confirmStatus(enabled) {
  await page
    .getByRole("button", {
      name: enabled ? "Review re-enable account" : "Review disable account",
      exact: true,
    })
    .click();
  await page
    .getByRole("button", {
      name: enabled ? "Confirm re-enable account" : "Confirm disable account",
      exact: true,
    })
    .click();
  await page.getByText("Account change applied.", { exact: true }).waitFor();
}
async function reverifyWithBackup() {
  const dialog = page.getByRole("dialog", {
    name: "Verify this management action",
  });
  await dialog.waitFor();
  await dimensions(360);
  for (const name of ["Workspace", "My Profile", "Staff Directory", "Sign out"])
    assert.equal(
      await page.getByRole("button", { name, exact: true }).isDisabled(),
      true,
    );
  assert.equal(
    await dialog
      .getByLabel("Your current password or passphrase")
      .evaluate((element) => element === document.activeElement),
    true,
  );
  await page.keyboard.press("Shift+Tab");
  assert.equal(
    await dialog
      .getByRole("button", { name: "Cancel action", exact: true })
      .evaluate((element) => element === document.activeElement),
    true,
  );
  await page.keyboard.press("Tab");
  await dialog
    .getByLabel("Your current password or passphrase", { exact: true })
    .fill(actor.password);
  await dialog
    .getByRole("button", { name: "Verify password", exact: true })
    .click();
  await dialog
    .getByLabel("Second verification factor", { exact: true })
    .selectOption("backup");
  await dialog
    .getByLabel("Single-use backup code", { exact: true })
    .fill(actorBackupCodes.shift());
  await dialog
    .getByRole("button", { name: "Verify and continue action", exact: true })
    .click();
  await dialog.waitFor({ state: "hidden" });
  await dimensions(1080);
}
async function fillProfile(profile) {
  for (const [label, value] of [
    ["First name", profile.firstName],
    ["Last name", profile.lastName],
    ["Father’s given name", profile.fatherName],
    ["Mother’s name (given name only)", profile.motherName],
    ["Date of birth", profile.dateOfBirth],
    ["Employment start date", profile.employmentStartDate],
    ["Address", profile.address],
    ["Phone", profile.phone],
    ["Individual email", profile.email],
    ["Qualification level", profile.qualification.level],
    ["Title / subject / branch", profile.qualification.title],
    [
      "Awarding school / university / institution",
      profile.qualification.institution,
    ],
  ])
    await page.getByLabel(label, { exact: true }).fill(value);
  for (const department of profile.departments)
    await page.getByLabel(department, { exact: true }).check();
  await page
    .getByLabel("Qualification type", { exact: true })
    .selectOption(profile.qualification.type);
}

try {
  connection = await connectStaffDatabase({
    database: "capstone_staff_test",
    demoMode: true,
  });
  assertIsolatedTestTarget(connection);
  vault = createVault(connection.config.key);
  assertIsolatedTestTarget(connection);
  for (const name of STAFF_COLLECTIONS)
    await connection.db.collection(name).deleteMany({});
  await connection.db
    .collection("staff_management_state")
    .insertOne({ _id: "staff-controls", revision: 0, createdAt: clock() });
  // A disposable, acknowledged Admin fixture is not a development account or a
  // provisioning route. Bootstrap/DEV/key files are never replaced by this run.
  actorBackupCodes = Array.from({ length: 10 }, () =>
    randomBytes(16).toString("hex"),
  );
  const actorSecret = generateSecret();
  await connection.db.collection("accounts").insertOne({
    _id: actor.id,
    username: actor.username,
    roles: ["Admin"],
    status: "active",
    version: 1,
    passwordHash: await argon2.hash(actor.password, {
      type: argon2.argon2id,
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
    }),
    createdAt: clock(),
    mfa: {
      enabled: true,
      version: 1,
      backupAcknowledged: true,
      secretCipher: vault.encrypt(actorSecret),
      lastAcceptedStep: Math.floor(clock().getTime() / 30000) - 2,
      backupCodes: actorBackupCodes.map((code) => ({
        digest: digest(code),
        usedAt: null,
      })),
    },
  });
  await connection.db.collection("staff_profiles").insertOne({
    _id: `synthetic-profile:${randomUUID()}`,
    accountId: actor.id,
    ...actorProfile,
    emailVerified: false,
    revision: 0,
  });
  await connection.db.collection("installation_state").insertOne({
    _id: "first-admin",
    status: "completed",
    completedAt: clock(),
    accountId: actor.id,
  });
  await mkdir(evidence, { recursive: true });
  await startServer();
  await launch();
  stage = "Admin sign-in and own profile";
  await dimensions(1080);
  await signIn(actor, true);
  await page
    .getByRole("heading", { name: "Staff workspace", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "My Profile", exact: true }).click();
  await page.getByText(actorProfile.fatherName, { exact: true }).waitFor();
  assert.equal(
    await page.getByText(actorProfile.motherName, { exact: true }).count(),
    1,
  );
  assert.equal(
    await page.getByText(actorProfile.dateOfBirth, { exact: true }).count(),
    1,
  );
  assert.equal(
    await page
      .getByRole("heading", { name: "My Profile", exact: true })
      .evaluate((element) => element === document.activeElement),
    true,
  );
  await page
    .getByText("Phone — unverified (Lebanon)", { exact: true })
    .waitFor();
  assert.equal(
    await page.locator(".staff-signed-in > span").textContent(),
    actor.username,
  );
  await dimensions(360);
  await safeScreenshot("signed-in-profile-narrow");
  await dimensions(1080);
  await page.getByRole("button", { name: "Edit profile", exact: true }).click();
  await page
    .getByLabel("Address", { exact: true })
    .fill("Synthetic updated own address");
  assert.equal(await page.getByLabel("Phone", { exact: true }).count(), 0);
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await page
    .getByText("Your address was updated. Saved contacts were not changed.", {
      exact: true,
    })
    .waitFor();
  assert.equal(
    (
      await connection.db
        .collection("staff_profiles")
        .findOne({ accountId: actor.id })
    ).phone,
    actorProfile.phone,
  );
  assert.equal(await page.getByRole("dialog").count(), 0);
  assert.equal(
    await page
      .getByRole("heading", { name: "My Profile", exact: true })
      .evaluate((element) => element === document.activeElement),
    true,
  );
  await page.getByRole("button", { name: "Edit profile", exact: true }).click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(
    await page
      .getByRole("heading", { name: "My Profile", exact: true })
      .evaluate((element) => element === document.activeElement),
    true,
  );
  await safeScreenshot("my-profile-desktop");
  await dimensions(360);
  await safeScreenshot("my-profile-narrow");
  await dimensions(1080);
  pass(stage);

  stage = "contact provider gate and private TEST email identity/possession";
  assert.equal(
    await page.getByRole("dialog", { name: "Change email" }).count(),
    0,
  );
  await page.getByRole("button", { name: "Edit profile", exact: true }).click();
  await page
    .getByLabel("Address", { exact: true })
    .fill("Synthetic address draft kept through email modal");
  await page.getByRole("button", { name: "Change email", exact: true }).click();
  stage = "email modal opens and receives focus";
  await page.getByRole("dialog", { name: "Change email" }).waitFor();
  assert.equal(
    await page
      .getByRole("heading", { name: "Change email", exact: true })
      .evaluate((element) => element === document.activeElement),
    true,
  );
  stage = "modal provider gate and configuration retry";
  await page
    .getByRole("button", { name: "Recheck email setup", exact: true })
    .waitFor();
  assert.equal(
    await page.getByLabel("Proposed email address", { exact: true }).count(),
    0,
  );
  contactReady = true;
  await page
    .getByRole("button", { name: "Recheck email setup", exact: true })
    .click();
  await page.getByLabel("Proposed email address", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: "Cancel email change", exact: true })
    .focus();
  await page.keyboard.press("Tab");
  assert.equal(
    await page
      .getByRole("dialog", { name: "Change email" })
      .evaluate((element) => element.contains(document.activeElement)),
    true,
  );
  await page.keyboard.press("Shift+Tab");
  assert.equal(
    await page
      .getByRole("button", { name: "Cancel email change", exact: true })
      .evaluate((element) => element === document.activeElement),
    true,
  );
  await page.mouse.click(3, 3); // Backdrop does not dismiss.
  assert.equal(
    await page.getByRole("dialog", { name: "Change email" }).count(),
    1,
  );
  stage = "same verified email rejection stays in entry step without delivery";
  // Synthetic live-shaped proof in TEST only; this is not a real delivery claim.
  const savedEmailProfile = await connection.db
    .collection("staff_profiles")
    .findOne({ accountId: actor.id });
  await connection.db.collection("staff_profiles").updateOne(
    { _id: savedEmailProfile._id },
    {
      $set: {
        emailVerification: {
          verifiedAt: new Date(),
          method: "email_code",
          provider: "gmail",
          mode: "live",
          valueDigest: vault.contactDigest(savedEmailProfile.email),
        },
      },
    },
  );
  const sameEmailMessageCount = contactMessages.length;
  await page
    .getByLabel("Proposed email address", { exact: true })
    .fill(savedEmailProfile.email.toUpperCase());
  await page
    .getByLabel("Your current password or passphrase", { exact: true })
    .fill(actor.password);
  await page
    .getByRole("button", { name: "Confirm my identity", exact: true })
    .click();
  await page
    .getByRole("alert")
    .filter({
      hasText:
        "This email is already verified. Enter a different address to change it.",
    })
    .waitFor();
  assert.equal(
    await page
      .getByLabel("Identity verification code", { exact: true })
      .count(),
    0,
  );
  assert.equal(
    await page
      .getByLabel("Proposed email address", { exact: true })
      .isVisible(),
    true,
  );
  assert.equal(
    await page
      .getByLabel("Your current password or passphrase", { exact: true })
      .inputValue(),
    "",
  );
  assert.equal(contactMessages.length, sameEmailMessageCount);
  assert.equal(
    await connection.db
      .collection("contact_requests")
      .countDocuments({ accountId: actor.id }),
    0,
  );
  // Restore this owned fixture's original proof so the remaining mock flow is
  // unchanged; never perform this fixture operation on development profiles.
  await connection.db
    .collection("staff_profiles")
    .updateOne(
      { _id: savedEmailProfile._id },
      savedEmailProfile.emailVerification
        ? { $set: { emailVerification: savedEmailProfile.emailVerification } }
        : { $unset: { emailVerification: "" } },
    );
  pass(stage);
  await page
    .getByLabel("Proposed email address", { exact: true })
    .fill("replacement@example.invalid");
  await page
    .getByLabel("Your current password or passphrase", { exact: true })
    .fill(actor.password);
  await page.keyboard.press("Tab");
  assert.equal(
    await page
      .getByRole("button", { name: "Confirm my identity", exact: true })
      .evaluate((element) => element === document.activeElement),
    true,
  );
  const identityEventsBefore = await connection.db
    .collection("security_events")
    .countDocuments({
      accountId: actor.id,
      action: "contact_identity_password_verified",
    });
  await page
    .getByRole("button", { name: "Confirm my identity", exact: true })
    .evaluate((button) => {
      button.form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
      button.form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
  stage = "modal administrative identity and wrong-factor retry";
  await page
    .getByLabel("Identity verification code", { exact: true })
    .fill("not-a-code");
  assert.equal(
    await connection.db.collection("security_events").countDocuments({
      accountId: actor.id,
      action: "contact_identity_password_verified",
    }),
    identityEventsBefore + 1,
  );
  await page
    .getByRole("button", {
      name: "Verify identity and send email code",
      exact: true,
    })
    .click();
  await page
    .getByText(
      "Contact verification failed. Check the details or start again.",
      { exact: true },
    )
    .waitFor();
  await page
    .getByLabel("Identity verification code", { exact: true })
    .fill(await totp(actor.username));
  await page
    .getByRole("button", {
      name: "Verify identity and send email code",
      exact: true,
    })
    .click();
  await page
    .getByLabel("Eight-digit code from the proposed email", { exact: true })
    .waitFor();
  stage = "modal narrow layout and leading-zero input";
  assert.equal(
    (
      await connection.db
        .collection("staff_profiles")
        .findOne({ accountId: actor.id })
    ).email,
    actorProfile.email,
  );
  await dimensions(360);
  assert.equal(
    await page
      .getByRole("dialog")
      .evaluate((element) => element.scrollWidth > element.clientWidth),
    false,
  );
  await safeScreenshot("profile-email-modal-pending-narrow", true);
  await page
    .getByLabel("Eight-digit code from the proposed email", { exact: true })
    .fill("00012345");
  assert.equal(
    await page
      .getByLabel("Eight-digit code from the proposed email", { exact: true })
      .inputValue(),
    "00012345",
  );
  await page
    .getByLabel("Eight-digit code from the proposed email", { exact: true })
    .fill("");
  await dimensions(1080);
  await safeScreenshot("profile-email-modal-pending-desktop", true);
  stage = "modal synthetic paste and possession completion";
  // Simulate paste only in this owned renderer; do not read/overwrite the
  // user's Windows clipboard, which may contain private information.
  await page
    .getByLabel("Eight-digit code from the proposed email", { exact: true })
    .evaluate((input, value) => {
      const transfer = new DataTransfer();
      transfer.setData("text/plain", value);
      input.dispatchEvent(
        new ClipboardEvent("paste", { bubbles: true, clipboardData: transfer }),
      );
      input.setRangeText(transfer.getData("text/plain"));
      input.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          inputType: "insertFromPaste",
          data: value,
        }),
      );
    }, contactMessages.at(-1).code);
  assert.equal(
    await page
      .getByLabel("Eight-digit code from the proposed email", { exact: true })
      .inputValue(),
    contactMessages.at(-1).code,
  );
  await page
    .getByRole("button", { name: "Verify email and save", exact: true })
    .evaluate((button) => {
      button.form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
      button.form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
  stage = "modal success refresh focus and preserved address draft";
  await page
    .getByText(
      "Individual email — automated test only — not real verification, contact only",
      { exact: true },
    )
    .waitFor();
  await page
    .getByText("Automated TEST result only. No real contact was verified.", {
      exact: true,
    })
    .waitFor();
  assert.equal(
    (
      await connection.db
        .collection("staff_profiles")
        .findOne({ accountId: actor.id })
    ).email,
    "replacement@example.invalid",
  );
  assert.equal(
    await page.getByRole("dialog", { name: "Change email" }).count(),
    0,
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Change email", exact: true })
      .evaluate((element) => element === document.activeElement),
    true,
  );
  assert.equal(
    await page.getByLabel("Address", { exact: true }).inputValue(),
    "Synthetic address draft kept through email modal",
  );
  assert.equal(
    (
      await connection.db
        .collection("staff_profiles")
        .findOne({ accountId: actor.id })
    ).address,
    "Synthetic updated own address",
  );
  await safeScreenshot("email-test-completed-desktop");
  await dimensions(360);
  await safeScreenshot("email-test-completed-narrow");
  await dimensions(1080);
  await page.getByRole("button", { name: "Change email", exact: true }).click();
  stage = "modal cancellation failure keeps dialog open";
  await page
    .getByLabel("Proposed email address", { exact: true })
    .fill("cancelled@example.invalid");
  await page
    .getByLabel("Your current password or passphrase", { exact: true })
    .fill(actor.password);
  await page
    .getByRole("button", { name: "Confirm my identity", exact: true })
    .click();
  await page
    .getByLabel("Identity verification code", { exact: true })
    .waitFor();
  await page.waitForFunction(
    () =>
      !document.querySelector(".staff-email-dialog > button:last-child")
        ?.disabled,
  );
  cancelFailure = true;
  await page.keyboard.press("Escape");
  await page
    .getByText("Synthetic cancellation unavailable. Retry without closing.", {
      exact: true,
    })
    .waitFor();
  assert.equal(
    await page.getByRole("dialog", { name: "Change email" }).count(),
    1,
  );
  cancelFailure = false;
  await page
    .getByRole("button", { name: "Cancel email change", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Change email" })
    .waitFor({ state: "hidden" });
  assert.equal(
    await page.getByLabel("Address", { exact: true }).inputValue(),
    "Synthetic address draft kept through email modal",
  );
  assert.equal(contactMessages.length, 1);
  stage = "modal expiry disables code submission without changing saved email";
  await page.getByRole("button", { name: "Change email", exact: true }).click();
  await page
    .getByLabel("Proposed email address", { exact: true })
    .fill("expiry@example.invalid");
  await page
    .getByLabel("Your current password or passphrase", { exact: true })
    .fill(actor.password);
  await page
    .getByRole("button", { name: "Confirm my identity", exact: true })
    .click();
  await page
    .getByLabel("Identity verification code", { exact: true })
    .fill(await totp(actor.username));
  await page
    .getByRole("button", {
      name: "Verify identity and send email code",
      exact: true,
    })
    .click();
  await page
    .getByLabel("Eight-digit code from the proposed email", { exact: true })
    .waitFor();
  expiryResponse = true;
  await page
    .getByRole("button", { name: "Refresh pending status", exact: true })
    .click();
  await page
    .getByText(
      "This request has expired. Cancel and start a new request. Your saved contact is unchanged.",
      { exact: true },
    )
    .waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Verify email and save", exact: true })
      .isDisabled(),
    true,
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Resend email code", exact: true })
      .isDisabled(),
    true,
  );
  expiryResponse = false;
  await page.keyboard.press("Escape");
  await page
    .getByRole("dialog", { name: "Change email" })
    .waitFor({ state: "hidden" });
  assert.equal(
    (
      await connection.db
        .collection("staff_profiles")
        .findOne({ accountId: actor.id })
    ).email,
    "replacement@example.invalid",
  );
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await page
    .getByText("Your address was updated. Saved contacts were not changed.", {
      exact: true,
    })
    .waitFor();
  assert.equal(
    (
      await connection.db
        .collection("staff_profiles")
        .findOne({ accountId: actor.id })
    ).address,
    "Synthetic address draft kept through email modal",
  );
  pass(stage);

  stage = "directory search clear and filters";
  await openDirectory();
  await page
    .getByLabel("Search staff", { exact: true })
    .fill("  SYNTHETIC   MANAGER  ");
  assert.equal(await page.locator(".staff-directory-row").count(), 1);
  await page
    .getByRole("button", { name: "Clear staff search", exact: true })
    .click();
  assert.equal(
    await page.getByLabel("Search staff", { exact: true }).inputValue(),
    "",
  );
  assert.equal(
    await page
      .getByLabel("Search staff", { exact: true })
      .evaluate((element) => element === document.activeElement),
    true,
  );
  await page
    .getByLabel("Role", { exact: true })
    .selectOption("Clinic Receptionist");
  await page
    .getByText("No staff match your search and filters.", { exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Clear search and filters", exact: true })
    .click();
  await page
    .getByLabel("Department", { exact: true })
    .selectOption("Administration");
  assert.equal(await page.locator(".staff-directory-row").count(), 1);
  await page.getByLabel("Department", { exact: true }).selectOption("");
  await page.getByLabel("Status", { exact: true }).selectOption("activated");
  assert.equal(await page.locator(".staff-directory-row").count(), 1);
  await page.getByLabel("Status", { exact: true }).selectOption("");
  await safeScreenshot("directory-desktop");
  await dimensions(360);
  await safeScreenshot("directory-narrow");
  await dimensions(1080);
  pass(stage);

  stage = "private receptionist creation";
  await page
    .getByRole("button", { name: "Create staff account", exact: true })
    .click();
  await page.getByLabel("Clinic Receptionist", { exact: true }).check();
  await fillProfile(employeeProfile);
  stage = "country-aware phone and consistent email validation";
  assert.equal(
    await page.getByLabel("Phone country", { exact: true }).inputValue(),
    "LB",
  );
  await page.getByLabel("Phone", { exact: true }).fill("000 placeholder");
  await page.getByLabel("Phone", { exact: true }).blur();
  await page
    .getByText("Enter a valid phone number for the selected country.", {
      exact: true,
    })
    .waitFor();
  assert.equal(
    await page
      .getByLabel("Phone", { exact: true })
      .evaluate((element) => element.checkValidity()),
    false,
  );
  await page.getByLabel("Phone", { exact: true }).fill("+1 (213) 373-4253");
  assert.equal(
    await page.getByLabel("Phone country", { exact: true }).inputValue(),
    "US",
  );
  assert.equal(
    await page.locator('input[name="phone"]').inputValue(),
    "+12133734253",
  );
  await page.getByLabel("Phone country", { exact: true }).selectOption("LB");
  await page.getByLabel("Phone", { exact: true }).fill("071-123456");
  assert.equal(
    await page.locator('input[name="phone"]').inputValue(),
    employeeProfile.phone,
  );
  assert.equal(
    await page
      .getByLabel("Phone", { exact: true })
      .evaluate((element) => element.checkValidity()),
    true,
  );
  await page
    .getByLabel("Individual email", { exact: true })
    .fill("person@-invalid.com");
  await page.getByLabel("Individual email", { exact: true }).blur();
  await page
    .getByText("Enter a valid email address, such as name@example.com.", {
      exact: true,
    })
    .waitFor();
  await page
    .getByLabel("Individual email", { exact: true })
    .fill(`  ${employeeProfile.email.toUpperCase()} `);
  assert.equal(
    await page
      .getByLabel("Individual email", { exact: true })
      .evaluate((element) => element.checkValidity()),
    true,
  );
  await dimensions(360);
  await safeScreenshot("country-contact-create-narrow");
  await dimensions(1080);
  pass(stage);
  stage = "private receptionist creation";
  await page
    .getByLabel("Assigned username", { exact: true })
    .fill(employee.username);
  await dimensions(360);
  await dimensions(1080);
  await page
    .getByRole("button", {
      name: "Create account and private setup code",
      exact: true,
    })
    .click();
  await handoff();
  await page
    .getByRole("button", {
      name: `View profile for ${employeeProfile.firstName} ${employeeProfile.lastName}`,
      exact: true,
    })
    .waitFor();
  assert.equal(await page.locator(".staff-directory-row").count(), 2);
  const created = await connection.db
    .collection("accounts")
    .findOne({ username: employee.username });
  assert.equal(created.status, "setup_pending");
  assert.equal(Boolean(created.passwordHash), false);
  employee.id = created._id;
  const initialContacts = await connection.db
    .collection("staff_profiles")
    .findOne({ accountId: employee.id });
  assert.equal(initialContacts.phone, employeeProfile.phone);
  assert.equal(initialContacts.phoneCountry, "LB");
  assert.equal(initialContacts.email, employeeProfile.email);
  pass(stage);

  stage = "pending disable re-enable and replacement";
  await openEmployee();
  await confirmStatus(false);
  assert.equal(
    (await connection.db.collection("accounts").findOne({ _id: employee.id }))
      .status,
    "disabled",
  );
  await confirmStatus(true);
  assert.equal(
    (await connection.db.collection("accounts").findOne({ _id: employee.id }))
      .status,
    "setup_pending",
  );
  const oldCode = employeeSetupCode;
  await page
    .getByRole("button", { name: "Review replacement setup code", exact: true })
    .click();
  await page
    .getByRole("button", {
      name: "Confirm replacement setup code",
      exact: true,
    })
    .click();
  await handoff();
  assert.notEqual(employeeSetupCode, oldCode);
  pass(stage);

  stage = "expired manager proof contact exemption and re-verification";
  clockOffset += 5 * 60000 + 5000;
  stage = "expired proof contact-only save";
  await page
    .getByRole("button", { name: "Edit this staff profile", exact: true })
    .click();
  await page
    .getByLabel("Address", { exact: true })
    .fill("Synthetic manager-updated address");
  await page
    .getByRole("button", { name: "Save staff profile", exact: true })
    .click();
  await page.getByText("Staff profile updated.", { exact: true }).waitFor();
  assert.equal(await page.getByRole("dialog").count(), 0);
  await page
    .getByRole("button", { name: "Edit this staff profile", exact: true })
    .waitFor({ state: "visible" });
  stage = "contact-only save returns focus";
  await page.waitForFunction(
    () =>
      document.activeElement?.tagName === "H1" &&
      document.activeElement.textContent === "Staff directory",
  );
  await page
    .getByRole("button", { name: "Edit this staff profile", exact: true })
    .click();
  await page
    .getByLabel("Father’s given name", { exact: true })
    .fill("Synthetic Confirmed Father");
  await page
    .getByRole("button", { name: "Save staff profile", exact: true })
    .click();
  const cancelledDialog = page.getByRole("dialog", {
    name: "Verify this management action",
  });
  stage = "sensitive edit opens verification";
  await cancelledDialog.waitFor();
  for (const name of ["Workspace", "My Profile", "Staff Directory", "Sign out"])
    assert.equal(
      await page.getByRole("button", { name, exact: true }).isDisabled(),
      true,
    );
  await page.keyboard.press("Escape");
  await cancelledDialog.waitFor({ state: "hidden" });
  stage = "cancelled verification returns focus without mutation";
  await page.waitForFunction(
    () =>
      document.activeElement?.tagName === "H1" &&
      document.activeElement.textContent === "Staff directory",
  );
  assert.notEqual(
    (
      await connection.db
        .collection("staff_profiles")
        .findOne({ accountId: employee.id })
    ).fatherName,
    "Synthetic Confirmed Father",
  );
  await page
    .getByRole("button", { name: "Save staff profile", exact: true })
    .click();
  stage = "replacement verification accepts private backup factor";
  await reverifyWithBackup();
  stage = "verified sensitive edit completes and returns focus";
  await page.getByText("Staff profile updated.", { exact: true }).waitFor();
  await page.waitForFunction(
    () =>
      document.activeElement?.tagName === "H1" &&
      document.activeElement.textContent === "Staff directory",
  );
  assert.equal(
    (
      await connection.db
        .collection("staff_profiles")
        .findOne({ accountId: employee.id })
    ).fatherName,
    "Synthetic Confirmed Father",
  );
  assert.equal(
    (
      await connection.db.collection("accounts").findOne({ _id: actor.id })
    ).mfa.backupCodes.filter((code) => code.usedAt).length,
    1,
  );
  await dimensions(360);
  await safeScreenshot("managed-profile-narrow");
  await dimensions(1080);
  await safeScreenshot("managed-profile-desktop");
  pass(stage);

  stage = "employee chooses password and self-only view";
  await signOut();
  await page
    .getByRole("button", {
      name: "Set up my assigned staff account",
      exact: true,
    })
    .click();
  await page
    .getByLabel("Assigned username", { exact: true })
    .fill(employee.username);
  await page
    .getByLabel("Private account setup code", { exact: true })
    .fill(employeeSetupCode);
  await page
    .getByLabel("Choose a password or passphrase", { exact: true })
    .fill(employee.password);
  await page
    .getByLabel("Confirm password", { exact: true })
    .fill(employee.password);
  await page
    .getByRole("button", { name: "Set password and continue", exact: true })
    .click();
  employeeSetupCode = undefined;
  await page
    .getByRole("heading", { name: "Staff workspace", exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Staff Directory", exact: true })
      .count(),
    0,
  );
  await page.getByRole("button", { name: "My Profile", exact: true }).click();
  await page.getByText("Synthetic Confirmed Father", { exact: true }).waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Edit this staff profile", exact: true })
      .count(),
    0,
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Review role changes", exact: true })
      .count(),
    0,
  );
  await page.getByRole("button", { name: "Edit profile", exact: true }).click();
  assert.equal(await page.getByLabel("Phone", { exact: true }).count(), 0);
  await page
    .getByLabel("Address", { exact: true })
    .fill("Synthetic receptionist updated address");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await page
    .getByText("Your address was updated. Saved contacts were not changed.", {
      exact: true,
    })
    .waitFor();
  assert.equal(
    (
      await connection.db
        .collection("staff_profiles")
        .findOne({ accountId: employee.id })
    ).phone,
    employeeProfile.phone,
  );
  pass(stage);

  stage = "receptionist modal skips MFA and handles delivery failure/retry";
  await page.getByRole("button", { name: "Edit profile", exact: true }).click();
  await page.getByRole("button", { name: "Change email", exact: true }).click();
  await page
    .getByLabel("Proposed email address", { exact: true })
    .fill("reception-replacement@example.invalid");
  await page
    .getByLabel("Your current password or passphrase", { exact: true })
    .fill(employee.password);
  contactFailure = true;
  await page
    .getByRole("button", { name: "Confirm my identity", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Refresh pending status", exact: true })
    .waitFor();
  stage =
    "receptionist failed delivery preserves contact and offers cancellation";
  assert.equal(
    await page
      .getByLabel("Identity verification code", { exact: true })
      .count(),
    0,
  );
  assert.equal(
    await page
      .getByLabel("Eight-digit code from the proposed email", { exact: true })
      .count(),
    0,
  );
  assert.equal(
    (
      await connection.db
        .collection("staff_profiles")
        .findOne({ accountId: employee.id })
    ).email,
    employeeProfile.email,
  );
  contactFailure = false;
  await page
    .getByRole("button", { name: "Cancel email change", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Change email" })
    .waitFor({ state: "hidden" });
  stage = "receptionist starts a replacement request after failed delivery";
  await page.getByRole("button", { name: "Change email", exact: true }).click();
  await page
    .getByLabel("Proposed email address", { exact: true })
    .fill("reception-replacement@example.invalid");
  await page
    .getByLabel("Your current password or passphrase", { exact: true })
    .fill(employee.password);
  await page
    .getByRole("button", { name: "Confirm my identity", exact: true })
    .click();
  await page
    .getByLabel("Eight-digit code from the proposed email", { exact: true })
    .waitFor();
  stage = "receptionist completes possession code and refreshes profile";
  await page
    .getByLabel("Eight-digit code from the proposed email", { exact: true })
    .fill(contactMessages.at(-1).code);
  await page
    .getByRole("button", { name: "Verify email and save", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Change email" })
    .waitFor({ state: "hidden" });
  assert.equal(
    (
      await connection.db
        .collection("staff_profiles")
        .findOne({ accountId: employee.id })
    ).email,
    "reception-replacement@example.invalid",
  );
  pass(stage);

  stage = "active disable re-enable preserves chosen password";
  await signOut();
  await signIn(actor, true);
  await page
    .getByRole("heading", { name: "Staff workspace", exact: true })
    .waitFor();
  await openDirectory();
  await openEmployee();
  const originalPasswordHash = (
    await connection.db.collection("accounts").findOne({ _id: employee.id })
  ).passwordHash;
  await confirmStatus(false);
  stage = "disabled email ownership rejects a new request without sending";
  const beforeMessages = contactMessages.length;
  await page.getByRole("button", { name: "My Profile", exact: true }).click();
  await page.getByRole("button", { name: "Edit profile", exact: true }).click();
  await page.getByRole("button", { name: "Change email", exact: true }).click();
  await page
    .getByLabel("Proposed email address", { exact: true })
    .fill("  RECEPTION-REPLACEMENT@EXAMPLE.INVALID ");
  await page
    .getByLabel("Your current password or passphrase", { exact: true })
    .fill(actor.password);
  await page
    .getByRole("button", { name: "Confirm my identity", exact: true })
    .click();
  await page
    .getByText("This email is used by another account", { exact: true })
    .waitFor();
  assert.equal(contactMessages.length, beforeMessages);
  assert.equal(
    await page.getByLabel("Proposed email address", { exact: true }).count(),
    1,
  );
  assert.equal(
    await page
      .getByLabel("Identity verification code", { exact: true })
      .count(),
    0,
  );
  assert.equal(
    await page
      .getByLabel("Your current password or passphrase", { exact: true })
      .inputValue(),
    "",
  );
  await page.keyboard.press("Escape");
  await page
    .getByRole("dialog", { name: "Change email" })
    .waitFor({ state: "hidden" });
  pass(stage);
  stage =
    "explicit Admin release confirmation, re-verification and retained history";
  await openDirectory();
  await openEmployee();
  clockOffset += 5 * 60000 + 5000;
  await page
    .getByRole("button", { name: "Review release verified email", exact: true })
    .click();
  await page
    .getByRole("heading", {
      name: "Confirm release verified email",
      exact: true,
    })
    .waitFor();
  await dimensions(360);
  await safeScreenshot("email-release-confirmation-narrow");
  await dimensions(1080);
  await page
    .getByRole("button", {
      name: "Confirm release verified email",
      exact: true,
    })
    .click();
  await reverifyWithBackup();
  await page
    .getByText(
      "Verified email reservation released. Historical contact retained; ownership will not return on reactivation.",
      { exact: true },
    )
    .waitFor();
  const releasedProfile = await connection.db
    .collection("staff_profiles")
    .findOne({ accountId: employee.id });
  assert.equal(releasedProfile.email, "reception-replacement@example.invalid");
  assert.equal(releasedProfile.emailVerification.releasedBy, actor.id);
  assert.equal(contactMessages.length, beforeMessages);
  assert.equal(
    await page
      .getByRole("button", {
        name: "Review release verified email",
        exact: true,
      })
      .count(),
    0,
  );
  await safeScreenshot("email-released-profile-desktop");
  pass(stage);
  stage = "active disable re-enable preserves chosen password";
  await confirmStatus(true);
  assert.ok(
    (
      await connection.db
        .collection("staff_profiles")
        .findOne({ accountId: employee.id })
    ).emailVerification.releasedAt,
  );
  const reenabled = await connection.db
    .collection("accounts")
    .findOne({ _id: employee.id });
  assert.equal(reenabled.status, "active");
  assert.equal(reenabled.passwordHash, originalPasswordHash);
  assert.equal(
    await page
      .getByRole("button", {
        name: "Review replacement setup code",
        exact: true,
      })
      .count(),
    0,
  );
  pass(stage);

  stage = "administrative promotion and interrupted MFA resumption";
  await page.getByLabel("Clinic Admin", { exact: true }).check();
  await page
    .getByRole("button", { name: "Review role changes", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Confirm role changes", exact: true })
    .click();
  await page.getByText("Account change applied.", { exact: true }).waitFor();
  assert.equal(
    (await connection.db.collection("accounts").findOne({ _id: employee.id }))
      .status,
    "mfa_pending",
  );
  await signOut();
  await signIn(employee);
  await page
    .getByRole("heading", { name: "Manual setup key", exact: true })
    .waitFor();
  const originalCipher = (
    await connection.db.collection("accounts").findOne({ _id: employee.id })
  ).pendingMfaSecretCipher;
  await closeClient();
  await stopServer();
  await startServer();
  await launch();
  await signIn(employee);
  await page
    .getByRole("heading", { name: "Manual setup key", exact: true })
    .waitFor();
  assert.deepEqual(
    (await connection.db.collection("accounts").findOne({ _id: employee.id }))
      .pendingMfaSecretCipher,
    originalCipher,
  );
  await page
    .getByLabel("Authenticator code", { exact: true })
    .fill(await totp(employee.username));
  await page
    .getByRole("button", { name: "Verify and continue", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Save your backup codes", exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByRole("button", {
        name: "I saved my codes — open workspace",
        exact: true,
      })
      .isDisabled(),
    true,
  );
  await page.getByRole("checkbox").check();
  await page
    .getByRole("button", {
      name: "I saved my codes — open workspace",
      exact: true,
    })
    .click();
  await page
    .getByRole("heading", { name: "Staff workspace", exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Staff Directory", exact: true })
      .count(),
    0,
  );
  await dimensions(360);
  await safeScreenshot("promoted-workspace-narrow");
  await dimensions(1080);
  pass(stage);

  stage = "System Admin read-only identity and protected work-details";
  await signOut();
  assertIsolatedTestTarget(connection);
  const system = {
    id: `synthetic:${randomUUID()}`,
    username: `review.system.${suffix}`,
    password: `Synthetic system ${randomBytes(24).toString("base64url")}`,
  };
  const systemProfile = syntheticProfile({
    firstName: "Synthetic",
    lastName: "System Manager",
    departments: ["Administration"],
    qualification: actorProfile.qualification,
  });
  await connection.db.collection("accounts").insertOne({
    _id: system.id,
    username: system.username,
    roles: ["System Admin", "Lab Receptionist"],
    status: "active",
    version: 1,
    passwordHash: await argon2.hash(system.password, {
      type: argon2.argon2id,
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
    }),
    createdAt: clock(),
    mfa: {
      enabled: true,
      version: 1,
      backupAcknowledged: true,
      secretCipher: vault.encrypt(generateSecret()),
      lastAcceptedStep: Math.floor(clock().getTime() / 30000) - 2,
      backupCodes: [],
    },
  });
  await connection.db.collection("staff_profiles").insertOne({
    _id: `synthetic-profile:${randomUUID()}`,
    accountId: system.id,
    ...systemProfile,
    emailVerified: false,
    revision: 0,
  });
  await signIn(system, true);
  await page
    .getByRole("heading", { name: "Staff workspace", exact: true })
    .waitFor();
  await openDirectory();
  await page
    .getByRole("button", {
      name: `View profile for ${actorProfile.firstName} ${actorProfile.lastName}`,
      exact: true,
    })
    .click();
  await page
    .getByRole("button", { name: "Edit this staff profile", exact: true })
    .click();
  assert.equal(
    await page
      .getByLabel("Employment start date", { exact: true })
      .evaluate((element) => element.readOnly),
    true,
  );
  for (const department of ["Clinic", "Laboratory", "Administration"])
    assert.equal(
      await page.getByLabel(department, { exact: true }).isDisabled(),
      true,
    );
  for (const label of [
    "First name",
    "Last name",
    "Father’s given name",
    "Mother’s name (given name only)",
    "Date of birth",
  ])
    assert.equal(
      await page.getByLabel(label, { exact: true }).isEditable(),
      false,
    );
  assert.equal(
    await page.getByLabel("Qualification type", { exact: true }).isDisabled(),
    true,
  );
  await dimensions(360);
  await safeScreenshot("protected-work-locked-narrow");
  await dimensions(1080);
  await safeScreenshot("protected-work-locked-desktop");
  const protectedBefore = await connection.db
    .collection("staff_profiles")
    .findOne({ accountId: actor.id });
  await page
    .getByLabel("Address", { exact: true })
    .fill("Synthetic System permitted address");
  await page
    .getByRole("button", { name: "Save staff profile", exact: true })
    .click();
  await page.getByText("Staff profile updated.", { exact: true }).waitFor();
  const protectedAfter = await connection.db
    .collection("staff_profiles")
    .findOne({ accountId: actor.id });
  assert.equal(protectedAfter.fatherName, protectedBefore.fatherName);
  assert.equal(protectedAfter.address, "Synthetic System permitted address");
  assert.deepEqual(protectedAfter.departments, protectedBefore.departments);
  assert.equal(
    protectedAfter.employmentStartDate,
    protectedBefore.employmentStartDate,
  );
  pass(stage);

  stage =
    "Admin edits another mixed protected account with recent verification";
  await signOut();
  await signIn(actor, true);
  await page
    .getByRole("heading", { name: "Staff workspace", exact: true })
    .waitFor();
  await openDirectory();
  await page
    .getByRole("button", {
      name: `View profile for ${systemProfile.firstName} ${systemProfile.lastName}`,
      exact: true,
    })
    .click();
  await page
    .getByRole("button", { name: "Edit this staff profile", exact: true })
    .click();
  assert.equal(
    await page
      .getByLabel("Employment start date", { exact: true })
      .isEditable(),
    true,
  );
  assert.equal(
    await page.getByLabel("Laboratory", { exact: true }).isEnabled(),
    true,
  );
  await page.getByLabel("Laboratory", { exact: true }).check();
  await page
    .getByLabel("Employment start date", { exact: true })
    .fill("2026-01-03");
  await dimensions(360);
  await safeScreenshot("protected-work-admin-narrow");
  await dimensions(1080);
  await page
    .getByRole("button", { name: "Save staff profile", exact: true })
    .click();
  await page.getByText("Staff profile updated.", { exact: true }).waitFor();
  const approvedWork = await connection.db
    .collection("staff_profiles")
    .findOne({ accountId: system.id });
  assert.deepEqual(approvedWork.departments, ["Laboratory", "Administration"]);
  assert.equal(approvedWork.employmentStartDate, "2026-01-03");
  pass(stage);
  await page.getByRole("button", { name: "Workspace", exact: true }).click();
  await page
    .getByRole("heading", { name: "Staff workspace", exact: true })
    .waitFor();

  stage = "owned-server outage and restricted transport";
  const isolation = await page.evaluate(() => ({
    local: localStorage.length,
    session: sessionStorage.length,
    node: typeof window.process,
  }));
  assert.deepEqual(isolation, { local: 0, session: 0, node: "undefined" });
  await stopServer();
  stage = "owned server outage blocks workspace";
  await page
    .getByRole("heading", {
      name: "Local staff server unavailable",
      exact: true,
    })
    .waitFor({ timeout: 25000 });
  assert.equal(await page.locator(".staff-signed-in").count(), 0);
  assert.equal(
    await page
      .getByRole("heading", { name: "Staff workspace", exact: true })
      .count(),
    0,
  );
  await startServer();
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  stage = "owned server restart requires fresh sign-in";
  await page
    .getByRole("heading", { name: "Sign in to Cedar Staff", exact: true })
    .waitFor();
  await closeClient();
  stage = "no renderer network attempts or runtime warnings";
  if (rendererRequests.length || errors.length)
    console.error(
      `Diagnostic categories only: ${JSON.stringify({ rendererNetworkAttempts: rendererRequests.length, errors })}`,
    );
  assert.equal(rendererRequests.length, 0);
  assert.equal(errors.length, 0);
  stage = "main requests stay on the explicit local authority";
  assert.equal(mainRequests.length > 0, true);
  assert.equal(
    mainRequests.every(
      (request) => request.origin === origin && !request.path.includes("?"),
    ),
    true,
  );
  stage = "expected management requests observed";
  for (const expectedPath of [
    "/staff",
    "/profiles/me",
    "/auth/reverify/start",
    "/auth/reverify/complete",
    "/account/setup",
  ])
    assert.equal(
      mainRequests.some((request) => request.path.endsWith(expectedPath)),
      true,
    );
  assert.equal(
    await connection.db.collection("accounts").countDocuments({}),
    3,
  );
  stage = "owned-server outage and restricted transport";
  pass(stage);
} catch {
  // Deliberately omit underlying assertion/network/error payloads: they may
  // contain staff fields, usernames, setup codes or factor material.
  console.error(
    `FAIL: ${packaged ? "packaged" : "development"} management ${stage}`,
  );
  console.error(
    `Safe TEST response codes only: ${JSON.stringify(serverFailureCodes.slice(-6))}`,
  );
  if (page) {
    const state = await page
      .evaluate(() => ({
        dialogs: document.querySelectorAll('[role="dialog"], dialog[open]')
          .length,
        activeTag: document.activeElement?.tagName,
        errors: document.querySelectorAll(".staff-error, .staff-global-error")
          .length,
        unavailable: [...document.querySelectorAll("h1")].some(
          (element) => element.textContent === "Local staff server unavailable",
        ),
        signedOut: [...document.querySelectorAll("h1")].some(
          (element) => element.textContent === "Sign in to Cedar Staff",
        ),
        profileEditor: Boolean(
          document.querySelector('input[name="fatherName"]'),
        ),
        screenClosed: [...document.querySelectorAll(".staff-error")].some(
          (element) =>
            element.textContent.includes("management screen is no longer open"),
        ),
        permissionDenied: [...document.querySelectorAll(".staff-error")].some(
          (element) => element.textContent.includes("permission"),
        ),
        invalidProfile: [...document.querySelectorAll(".staff-error")].some(
          (element) =>
            /field|qualification|department|date of birth/.test(
              element.textContent,
            ),
        ),
        noChanges: [...document.querySelectorAll(".staff-error")].some(
          (element) => element.textContent.includes("No profile changes"),
        ),
        refusedAction: [...document.querySelectorAll(".staff-error")].some(
          (element) =>
            element.textContent.includes("application action was refused"),
        ),
        verificationRequired: [
          ...document.querySelectorAll(".staff-error"),
        ].some((element) =>
          element.textContent.includes("Verify your password"),
        ),
        stale: [...document.querySelectorAll(".staff-error")].some((element) =>
          element.textContent.includes("record changed"),
        ),
      }))
      .catch(() => ({ unavailable: true }));
    console.error(`Diagnostic counts only: ${JSON.stringify(state)}`);
  }
  process.exitCode = 1;
} finally {
  try {
    await closeClient();
    await stopServer();
    if (connection) {
      assertIsolatedTestTarget(connection);
      for (const name of STAFF_COLLECTIONS)
        await connection.db.collection(name).deleteMany({});
      await connection.client.close();
    }
  } catch {
    console.error("FAIL: management guarded test cleanup");
    process.exitCode = 1;
  } finally {
    employeeSetupCode = undefined;
    actorBackupCodes = [];
    vault?.destroy();
  }
}
