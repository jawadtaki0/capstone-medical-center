import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { resolve, relative, isAbsolute, sep } from "node:path";
import { access, mkdir } from "node:fs/promises";
import { _electron as electron } from "playwright";

// Owned dummy authority only. No MongoDB, protected configuration or providers.
const root = resolve("apps/staff"),
  args = process.argv.slice(2);
assert.ok(!args.length || (args.length === 2 && args[0] === "--package"));
const executable = args.length ? resolve(args[1]) : undefined;
if (executable) {
  const path = relative(resolve(root, "release"), executable);
  assert.ok(
    path &&
      !path.startsWith(`..${sep}`) &&
      !isAbsolute(path) &&
      path.endsWith(".exe"),
  );
  await access(executable);
}
let client,
  page,
  scenario,
  checkpoints = 0,
  stage = "startup";
const errors = [],
  unexpected = [],
  network = [];
const reply = (response, body, status = 200) => {
  if (!response.writableEnded && !response.destroyed) {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
  }
};
const grant = (state, scope = "password") => ({
  challenge: "r".repeat(43),
  kind: `recovery_${state}`,
  scope,
  serverNow: new Date(scenario.anchor).toISOString(),
  expiresAt: new Date(scenario.anchor + 300000).toISOString(),
});
const employee = {
  id: "synthetic:employee",
  name: "Synthetic Employee",
  username: "synthetic.employee",
  roles: ["Lab Admin"],
  status: "active",
  version: 1,
  departments: ["Laboratory"],
  mfaEnabled: true,
};
const actor = {
  ...employee,
  id: "synthetic:actor",
  name: "Synthetic Admin",
  username: "synthetic.admin",
  roles: ["Admin"],
};
const session = () => ({
  serverNow: new Date(scenario.anchor).toISOString(),
  idleExpiresAt: new Date(scenario.anchor + 600000).toISOString(),
  absoluteExpiresAt: new Date(scenario.anchor + 28800000).toISOString(),
});
const server = createServer(async (request, response) => {
  let text = "";
  for await (const chunk of request) {
    text += chunk;
    assert.ok(text.length < 16000);
  }
  const body = text ? JSON.parse(text) : {},
    path = request.url;
  scenario.calls.push(path);
  if (path === "/health")
    return reply(response, { status: "ok", database: "connected" });
  if (path === "/setup/status") return reply(response, { available: false });
  if (
    path === "/auth/login" ||
    path === "/auth/session" ||
    path === "/auth/activity"
  )
    return reply(response, {
      token: "s".repeat(43),
      user: actor,
      session: session(),
    });
  if (path === "/workspace")
    return reply(response, {
      roles: actor.roles,
      heading: "Staff workspace",
      permissions: [
        "workspace:view",
        "staff:directory",
        "staff:profiles",
        "staff:manage",
        "staff:protected:manage",
      ],
    });
  if (path === "/staff")
    return reply(response, {
      staff: [employee],
      roles: ["Admin", "Clinic Admin", "Lab Admin"],
      departments: ["Laboratory"],
    });
  if (path === "/staff/synthetic%3Aemployee/profile")
    return reply(response, {
      account: employee,
      profile: {
        firstName: "Synthetic",
        lastName: "Employee",
        fatherName: "Synthetic",
        motherName: "Synthetic",
        dateOfBirth: "1990-01-15",
        address: "Synthetic address",
        phone: "+96171123456",
        email: "synthetic@example.invalid",
        departments: ["Laboratory"],
        employmentStartDate: "2026-10-01",
        qualification: {
          type: "university",
          title: "Synthetic degree",
          institution: "Synthetic university",
        },
        revision: 1,
      },
    });
  if (path === "/staff/synthetic%3Aemployee/recovery")
    return reply(response, {
      handoff: "DUMMY-PRIVATE-HANDOFF",
      scope: body.scope,
      serverNow: new Date(scenario.anchor).toISOString(),
      displayExpiresAt: new Date(scenario.anchor + 60000).toISOString(),
      expiresAt: new Date(scenario.anchor + 1800000).toISOString(),
    });
  if (path === "/staff/synthetic%3Aemployee/recovery/revoke")
    return reply(response, { revoked: true });
  if (path === "/recovery/request") {
    if (scenario.delayedRequest) {
      scenario.delayed = response;
      return;
    }
    return reply(response, {
      ...grant("email"),
      message:
        "If this account is eligible, recovery instructions will be sent.",
    });
  }
  if (path === "/recovery/verify") {
    assert.equal(body.code, "00123456");
    return reply(response, grant(scenario.admin ? "mfa" : "ready"));
  }
  if (path === "/recovery/factor") return reply(response, grant("ready"));
  if (path === "/recovery/redeem")
    return reply(response, grant("ready", "both"));
  if (path === "/recovery/complete") {
    scenario.saves++;
    if (scenario.busy) {
      scenario.busy = false;
      return reply(
        response,
        {
          error: {
            code: "recovery_busy",
            message:
              "Server busy. Your entries are kept; no history allowance used.",
          },
        },
        409,
      );
    }
    if (scenario.combined) return reply(response, grant("enroll", "mfa"));
    return reply(response, {
      completed: true,
      message: "Password saved. Sign in with your new password.",
    });
  }
  if (path === "/recovery/enrollment") {
    const enrollment = {
      ...grant("enroll", "mfa"),
      secret: "DUMMY-REPLACEMENT-SEED",
      uri: "otpauth://totp/Cedar:dummy?secret=JBSWY3DPEHPK3PXP&issuer=Cedar",
    };
    if (scenario.delayedEnrollment) {
      scenario.delayed = response;
      scenario.enrollment = enrollment;
      return;
    }
    return reply(response, enrollment);
  }
  if (path === "/recovery/enroll" || path === "/recovery/backups")
    return reply(response, {
      ...grant("backups", "mfa"),
      backupCodes: ["DUMMY-BACKUP-ONE", "DUMMY-BACKUP-TWO"],
    });
  if (path === "/recovery/acknowledge")
    return reply(response, {
      completed: true,
      message: "Recovery complete. Sign in again.",
    });
  if (path === "/recovery/status") {
    if (scenario.statusFailure)
      return reply(
        response,
        {
          error: {
            code: "recovery_expired",
            message: "Authorization no longer valid.",
          },
        },
        409,
      );
    return reply(response, grant("ready"));
  }
  if (path === "/recovery/cancel") {
    if (scenario.cancelFailure) {
      scenario.cancelFailure = false;
      return reply(
        response,
        {
          error: {
            code: "unavailable",
            message: "Dummy cancellation unavailable",
          },
        },
        503,
      );
    }
    return reply(response, { cancelled: true });
  }
  unexpected.push(path);
  reply(
    response,
    { error: { code: "dummy_refused", message: "Fixture refused action" } },
    403,
  );
});
function pass(name) {
  console.log(`PASS ${++checkpoints}: ${name}`);
}
async function launch(admin = false) {
  await client?.close();
  scenario = { admin, anchor: Date.now(), calls: [], saves: 0 };
  client = await electron.launch({
    ...(executable
      ? { executablePath: executable, args: ["--demo-loopback"] }
      : { args: [root, "--demo-loopback"] }),
    env: { ...process.env, STAFF_API_URL: "http://127.0.0.1:4101" },
    timeout: 30000,
  });
  page = await client.firstWindow();
  page.on("pageerror", () => errors.push("renderer exception"));
  page.on("console", (message) => {
    if (
      message.type() === "error" ||
      /Electron Security Warning/i.test(message.text())
    )
      errors.push("runtime/security warning");
  });
  page.on("request", (request) => {
    if (/^https?:/i.test(request.url()))
      network.push("renderer external request");
  });
  await page.getByRole("heading", { name: "Sign in to Cedar Staff" }).waitFor();
  await page.clock.install({ time: new Date(scenario.anchor) });
  await page.clock.pauseAt(new Date(scenario.anchor + 1000));
  await page.clock.setSystemTime(new Date(scenario.anchor));
  await page.reload();
  await page.getByRole("button", { name: /Forgot password.*recover/i }).click();
  await page
    .getByRole("dialog", { name: "Recover staff account access" })
    .waitFor();
}
async function email() {
  await page
    .getByRole("button", {
      name: "Forgot password — verified email",
      exact: true,
    })
    .click();
  await page.getByLabel("Assigned username").fill("synthetic.recovery");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByLabel("Eight-digit email recovery code").fill("00123456");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  if (scenario.admin) {
    await page.getByLabel("Verification method").selectOption("backup");
    await page
      .getByLabel("Authenticator or unused backup code")
      .fill("DUMMY-BACKUP");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
  }
  await page.getByLabel("New password or passphrase").waitFor();
}
async function entries() {
  await page
    .getByLabel("New password or passphrase")
    .fill("Synthetic never-used recovery password");
  await page
    .getByLabel("Confirm new password exactly")
    .fill("Synthetic never-used recovery password");
}
async function narrow() {
  await client.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(360, 740),
  );
  await page.waitForFunction(() => window.innerWidth <= 360);
  assert.equal(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <= innerWidth &&
        [...document.querySelectorAll("dialog[open]")].every(
          (element) => element.scrollWidth <= element.clientWidth,
        ),
    ),
    true,
  );
}
async function waitDelayed() {
  for (let i = 0; i < 100 && !scenario.delayed; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(scenario.delayed);
}
async function expire() {
  await page.clock.setSystemTime(new Date(scenario.anchor + 300001));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page
    .getByRole("alert")
    .filter({ hasText: /expired/i })
    .waitFor();
}
try {
  server.listen(4101, "127.0.0.1");
  await once(server, "listening");
  stage = "email/receptionist";
  await launch();
  assert.equal(
    await page.evaluate(() => document.activeElement?.tagName),
    "H2",
  );
  await page.keyboard.press("Tab");
  assert.equal(
    await page.evaluate(
      () => document.activeElement?.closest("dialog") !== null,
    ),
    true,
  );
  pass("dialog focus enters and keyboard remains inside");
  await email();
  await narrow();
  pass("leading-zero email code and receptionist flow; 360px no overflow");
  await entries();
  scenario.busy = true;
  await page
    .getByRole("button", { name: "Save new password", exact: true })
    .click();
  await page.getByRole("alert").filter({ hasText: /busy/i }).waitFor();
  assert.equal(
    await page.getByLabel("New password or passphrase").inputValue(),
    "Synthetic never-used recovery password",
  );
  pass("busy refusal retains entries and permits retry");
  await page
    .getByRole("button", { name: "Save new password", exact: true })
    .click();
  await page.getByRole("heading", { name: "Sign in to Cedar Staff" }).waitFor();
  await page.getByRole("dialog").waitFor({ state: "detached" });
  assert.equal(await page.getByRole("dialog").count(), 0);
  pass("completion clears popup and returns to sign-in");
  stage = "administrative MFA";
  await launch(true);
  await email();
  assert.ok(scenario.calls.includes("/recovery/factor"));
  pass(
    "administrative password recovery requires the separate existing factor step",
  );
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "detached" });
  assert.equal(
    await page
      .getByRole("button", { name: /Forgot password.*recover/i })
      .evaluate((element) => element === document.activeElement),
    true,
  );
  pass("Escape cancels and returns keyboard focus");
  stage = "enrollment expiry";
  await launch();
  scenario.combined = true;
  await email();
  await entries();
  await page
    .getByRole("button", { name: "Save new password", exact: true })
    .click();
  await page.getByText("DUMMY-REPLACEMENT-SEED", { exact: true }).waitFor();
  await narrow();
  await expire();
  assert.equal(
    await page.getByText("DUMMY-REPLACEMENT-SEED", { exact: true }).count(),
    0,
  );
  assert.equal(
    await page.getByAltText("Replacement authenticator setup QR").count(),
    0,
  );
  pass(
    "actual deadline removes seed/QR on suspension while health remains available",
  );
  stage = "backup expiry";
  await launch();
  scenario.combined = true;
  await email();
  await entries();
  await page
    .getByRole("button", { name: "Save new password", exact: true })
    .click();
  await page.getByLabel("New authenticator code").fill("000000");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByText("DUMMY-BACKUP-ONE", { exact: true }).waitFor();
  await expire();
  assert.equal(
    await page.getByText("DUMMY-BACKUP-ONE", { exact: true }).count(),
    0,
  );
  pass("backup-code references/display removed at deadline");
  stage = "delayed enrollment";
  await launch();
  scenario.combined = true;
  scenario.delayedEnrollment = true;
  await email();
  await entries();
  await page
    .getByRole("button", { name: "Save new password", exact: true })
    .click();
  await waitDelayed();
  await expire();
  reply(scenario.delayed, scenario.enrollment);
  await page.waitForTimeout(100);
  assert.equal(
    await page.getByText("DUMMY-REPLACEMENT-SEED", { exact: true }).count(),
    0,
  );
  pass("delayed enrollment cannot restore expired private content");
  stage = "cancel failure";
  await launch();
  await email();
  scenario.cancelFailure = true;
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: /Cancellation could not be confirmed/ })
    .waitFor();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "detached" });
  pass("failed cancellation remains visible, retry safely closes");
  stage = "delayed request cancellation";
  await launch();
  scenario.delayedRequest = true;
  await page
    .getByRole("button", {
      name: "Forgot password — verified email",
      exact: true,
    })
    .click();
  await page.getByLabel("Assigned username").fill("synthetic.recovery");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await waitDelayed();
  await page.keyboard.press("Escape");
  reply(scenario.delayed, grant("email"));
  await page.getByRole("dialog").waitFor({ state: "detached" });
  pass("cancellation invalidates delayed authorization response");
  stage = "Admin assistance";
  await launch(true);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "detached" });
  await page.getByLabel("Username", { exact: true }).fill("synthetic.admin");
  await page
    .getByLabel("Password or passphrase")
    .fill("Synthetic dummy password only");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .getByRole("button", { name: "Staff Directory", exact: true })
    .click();
  await page
    .getByRole("button", { name: "View profile for Synthetic Employee" })
    .click();
  await page.getByLabel("Recovery scope").selectOption("both");
  await page
    .getByLabel("Purpose (no private documents or secrets)")
    .fill("Dummy in-person review");
  await page
    .getByLabel("I confirmed this employee’s identity in person")
    .check();
  await page
    .getByRole("button", { name: "Authorize private recovery handoff" })
    .click();
  await page
    .getByRole("dialog", { name: "Private recovery handoff" })
    .waitFor();
  await page.getByText("DUMMY-PRIVATE-HANDOFF", { exact: true }).waitFor();
  await narrow();
  pass("Admin private handoff display and narrow layout");
  await page.clock.setSystemTime(new Date(scenario.anchor + 60001));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page
    .getByText(
      "Private display expired. The handed-over token retains its original deadline.",
    )
    .waitFor();
  assert.equal(
    await page.getByText("DUMMY-PRIVATE-HANDOFF", { exact: true }).count(),
    0,
  );
  await page.getByRole("button", { name: "Close private display" }).click();
  await page
    .getByLabel(/Revoke this employee's unused assisted handoffs/)
    .check();
  await page
    .getByRole("button", { name: "Revoke private recovery handoffs" })
    .click();
  await page
    .getByRole("status")
    .filter({ hasText: /Private assisted handoffs revoked/ })
    .waitFor();
  pass(
    "private handoff clears at deadline; explicit revocation acknowledgement works",
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(network, []);
  assert.deepEqual(unexpected, []);
  pass(
    "no renderer runtime/security errors, external requests or unexpected API paths",
  );
  await mkdir(".local/recovery-review", { recursive: true });
  await page.screenshot({
    path: `.local/recovery-review/${executable ? "packaged" : "development"}-signin.png`,
  });
  console.log(
    `Recovery native checks: ${checkpoints} passed (${executable ? "packaged" : "development"}; owned mock authority).`,
  );
} catch (error) {
  console.error(
    `Recovery native check failed at ${stage}: ${error.name}: ${error.message}`,
  );
  process.exitCode = 1;
} finally {
  await client?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
