import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { resolve, relative, isAbsolute, sep } from "node:path";
import { access, mkdir } from "node:fs/promises";
import { _electron as electron } from "playwright";

// Native desktop with owned, dummy-only local authority. No protected config,
// database, delivery providers or development credentials are loaded here.
const root = resolve("apps/staff"),
  args = process.argv.slice(2);
assert.ok(args.length === 0 || (args.length === 2 && args[0] === "--package"));
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
const dummyPassword = "Synthetic password fixture only";
const dummyNew = "Synthetic never used password fixture";
let scenario,
  client,
  page,
  checkpoints = 0,
  stage = "startup";
const errors = [],
  external = [],
  unexpected = [];
const reply = (response, body, status = 200) => {
  if (!response.writableEnded && !response.destroyed) {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
  }
};
function session() {
  return {
    serverNow: new Date(scenario.anchor + scenario.elapsed).toISOString(),
    idleExpiresAt: new Date(scenario.anchor + 600000).toISOString(),
    absoluteExpiresAt: new Date(scenario.anchor + 28800000).toISOString(),
  };
}
function authorization() {
  return {
    kind: scenario.roles.some((role) => role.includes("Admin"))
      ? "password_mfa"
      : "password_ready",
    challenge: "d".repeat(43),
    serverNow: new Date(scenario.anchor + scenario.elapsed).toISOString(),
    expiresAt: new Date(scenario.anchor + 300000).toISOString(),
  };
}
const account = () => ({
  id: "synthetic:password-ui",
  username: "synthetic.password.review",
  roles: scenario.roles,
  status: "active",
});
const profile = () => ({
  firstName: "Synthetic",
  lastName: "Review",
  fatherName: "Synthetic",
  motherName: "Synthetic",
  dateOfBirth: "1990-01-15",
  address: "Synthetic saved address",
  phone: "+96171123456",
  email: "synthetic@example.invalid",
  departments: ["Clinic"],
  employmentStartDate: "2026-10-01",
  qualification: {
    type: "university",
    title: "Synthetic qualification",
    institution: "Synthetic institution",
  },
  revision: 0,
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
  if (path === "/auth/login")
    return reply(response, {
      token: "s".repeat(43),
      user: account(),
      session: session(),
    });
  if (path === "/auth/session" || path === "/auth/activity")
    return reply(response, { user: account(), session: session() });
  if (path === "/auth/logout") return reply(response, { signedOut: true });
  if (path === "/workspace")
    return reply(response, {
      roles: scenario.roles,
      permissions: ["workspace:view", "profile:own:view"],
      heading: "Staff workspace",
    });
  if (path === "/profiles/me")
    return reply(response, { account: account(), profile: profile() });
  if (path === "/password/change/start") {
    assert.equal(body.password, dummyPassword);
    if (scenario.holdStart) {
      scenario.delayed = response;
      return;
    }
    return reply(response, authorization());
  }
  if (path === "/password/change/identity")
    return reply(response, { ...authorization(), kind: "password_ready" });
  if (path === "/password/change/complete") {
    scenario.saves += 1;
    if (scenario.holdSave) {
      scenario.delayed = response;
      return;
    }
    if (scenario.busyOnce) {
      scenario.busyOnce = false;
      return reply(
        response,
        {
          error: {
            code: "password_change_busy",
            message:
              "The server is busy checking passwords. Try again shortly. Your entries have been kept; no history-check allowance was used.",
          },
        },
        409,
      );
    }
    return reply(response, { passwordChanged: true });
  }
  if (path === "/password/change/cancel") {
    if (scenario.cancelFailure) {
      scenario.cancelFailure = false;
      return reply(
        response,
        {
          error: {
            code: "password_cancel_failed",
            message: "Synthetic cancellation not confirmed",
          },
        },
        409,
      );
    }
    return reply(response, { cancelled: true });
  }
  unexpected.push(path);
  reply(
    response,
    {
      error: {
        code: "fixture_refused",
        message: "Dummy fixture refused action",
      },
    },
    403,
  );
});
function pass(name) {
  checkpoints += 1;
  console.log(`PASS ${checkpoints}: ${name}`);
}
async function launch(roles = ["Admin"]) {
  await client?.close();
  scenario = { roles, anchor: Date.now(), elapsed: 0, calls: [], saves: 0 };
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
      external.push("renderer network request");
  });
  await page.getByRole("heading", { name: "Sign in to Cedar Staff" }).waitFor();
  await page.clock.install({ time: new Date(scenario.anchor) });
  await page.clock.pauseAt(new Date(scenario.anchor + 1000));
  await page.clock.setSystemTime(new Date(scenario.anchor));
  await page.reload();
  await page
    .getByLabel("Username", { exact: true })
    .fill("synthetic.password.review");
  await page.getByLabel("Password or passphrase").fill(dummyPassword);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "My Profile", exact: true }).click();
  await page
    .getByRole("button", { name: "Change password", exact: true })
    .waitFor();
}
async function open() {
  await page
    .getByRole("button", { name: "Change password", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Change password", exact: true })
    .waitFor();
}
async function identify() {
  await page
    .getByLabel("Current password or passphrase", { exact: true })
    .fill(dummyPassword);
  await page
    .getByRole("button", { name: "Confirm current password", exact: true })
    .click();
  if (scenario.roles.some((role) => role.includes("Admin"))) {
    await page
      .getByLabel("Identity verification code", { exact: true })
      .fill("000000");
    await page
      .getByRole("button", { name: "Verify identity", exact: true })
      .click();
  }
  await page
    .getByLabel("New password or passphrase", { exact: true })
    .waitFor();
}
async function entries() {
  await page
    .getByLabel("New password or passphrase", { exact: true })
    .fill(dummyNew);
  await page.getByLabel("Confirm new password", { exact: true }).fill(dummyNew);
}
async function waitMock() {
  const end = Date.now() + 3000;
  while (!scenario.delayed && Date.now() < end)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(scenario.delayed, "Expected delayed mock request");
}
try {
  await mkdir(resolve(".local/password-change-review-2026-10-12"), {
    recursive: true,
  });
  server.listen(4101, "127.0.0.1");
  await once(server, "listening");
  stage = "native role flows and busy input preservation";
  for (const roles of [
    ["Admin"],
    ["Clinic Admin"],
    ["Clinic Admin"],
    ["Lab Admin"],
    ["Receptionist"],
    ["Receptionist"],
    ["Receptionist", "Lab Admin"],
  ]) {
    await launch(roles);
    await open();
    if (roles.length === 1 && roles[0] === "Admin")
      await page.screenshot({
        path: resolve(
          ".local/password-change-review-2026-10-12/password-dialog-desktop.png",
        ),
      }); // Empty fields, dummy fixture only.
    assert.ok(
      await page
        .getByRole("heading", { name: "Change password", exact: true })
        .evaluate((element) => element === document.activeElement),
    );
    await identify();
    await entries();
    scenario.busyOnce = true;
    await page
      .getByRole("button", { name: "Save password and sign out", exact: true })
      .click();
    await page
      .getByRole("alert")
      .filter({ hasText: "server is busy" })
      .waitFor();
    assert.equal(
      await page
        .getByLabel("New password or passphrase", { exact: true })
        .inputValue(),
      dummyNew,
    );
    assert.equal(
      await page
        .getByLabel("Confirm new password", { exact: true })
        .inputValue(),
      dummyNew,
    );
    await page
      .getByRole("button", { name: "Save password and sign out", exact: true })
      .click();
    await page
      .getByRole("heading", { name: "Sign in to Cedar Staff", exact: true })
      .waitFor();
    assert.match(
      await page.getByRole("alert").textContent(),
      /All your sessions were signed out/,
    );
    assert.equal(await page.getByRole("dialog").count(), 0);
    pass(
      `${roles.join(" + ")}: role flow, busy keeps inputs, successful save clears private display`,
    );
  }
  stage = "focus, keyboard and narrow layout";
  await launch();
  await open();
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press("Tab");
    assert.ok(
      await page
        .locator("dialog")
        .evaluate((element) => element.contains(document.activeElement)),
    );
  }
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "detached" });
  assert.ok(
    await page
      .getByRole("button", { name: "Change password", exact: true })
      .evaluate((element) => element === document.activeElement),
  );
  pass("native focus trap, Escape cancellation and focus return");
  await open();
  await identify();
  await client.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(360, 750),
  );
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  );
  assert.ok(
    await page
      .locator("dialog")
      .evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
  );
  await page.screenshot({
    path: resolve(
      ".local/password-change-review-2026-10-12/password-dialog-narrow.png",
    ),
  }); // Empty fields, dummy fixture only.
  await entries();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  pass("360px wrapping, no page/dialog overflow and Cancel clears inputs");
  stage = "expiry and suspension";
  await open();
  await identify();
  await entries();
  scenario.elapsed = 300001;
  await page.clock.setSystemTime(new Date(scenario.anchor + scenario.elapsed));
  await page.evaluate(() => window.dispatchEvent(new Event("pageshow")));
  await page
    .getByRole("alert")
    .filter({ hasText: "authorization expired" })
    .waitFor();
  assert.equal(await page.locator('dialog input[type="password"]').count(), 0);
  assert.equal((await fetch("http://127.0.0.1:4101/health")).status, 200);
  pass(
    "no-tick suspension deadline removes secret inputs while health remains available",
  );
  stage = "late start cancellation";
  await launch();
  await open();
  scenario.holdStart = true;
  await page
    .getByLabel("Current password or passphrase", { exact: true })
    .fill(dummyPassword);
  await page
    .getByRole("button", { name: "Confirm current password", exact: true })
    .click();
  await waitMock();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "detached" });
  reply(scenario.delayed, authorization());
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(await page.getByRole("dialog").count(), 0);
  pass(
    "delayed password authorization cannot reopen a cancelled private screen",
  );
  stage = "cancellation failure and retry";
  scenario.holdStart = false;
  await open();
  await identify();
  await entries();
  scenario.cancelFailure = true;
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: "Cancellation could not be confirmed" })
    .waitFor();
  assert.equal(await page.locator('dialog input[type="password"]').count(), 0);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "detached" });
  pass(
    "failed cancellation is visible and retryable without retaining private inputs",
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  assert.deepEqual(unexpected, []);
  pass(
    "no runtime/security errors, renderer external requests or unexpected API actions",
  );
  console.log(
    `PASS: ${checkpoints} native ${executable ? "packaged" : "development"} password-change checkpoints (dummy authority, no database/delivery).`,
  );
} catch (error) {
  console.error(
    `FAIL at ${stage}: ${error.name}. Dummy-only verifier; no development data touched.`,
  );
  throw error;
} finally {
  await client?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
