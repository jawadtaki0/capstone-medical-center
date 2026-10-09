import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { resolve, relative, isAbsolute, sep } from "node:path";
import { access } from "node:fs/promises";
import { _electron as electron } from "playwright";

// Real packaged/development renderer, mocked local authority. This verifier
// never loads protected configuration, MongoDB, delivery providers or real
// accounts. Do not capture screenshots or print secret-bearing responses.
const root = resolve("apps/staff");
const args = process.argv.slice(2);
assert.ok(
  args.length === 0 || (args.length === 2 && args[0] === "--package"),
  "Use no arguments, or --package <review executable>",
);
const executable = args.length ? resolve(args[1]) : undefined;
if (executable) {
  const inside = relative(resolve(root, "release"), executable);
  assert.ok(
    inside && !inside.startsWith(`..${sep}`) && !isAbsolute(inside),
    "The review executable must be inside apps/staff/release",
  );
  assert.ok(executable.endsWith(".exe"), "Expected a review .exe");
  await access(executable);
}

const dummySeed = "JBSWY3DPEHPK3PXP";
const dummyBackupCodes = ["1111-2222-3333-4444", "5555-6666-7777-8888"];
const savedFactors = {
  pendingFactor: dummySeed,
  backupCodes: [...dummyBackupCodes],
};
const factorSnapshot = structuredClone(savedFactors);
let scenario,
  page,
  client,
  completed = 0,
  stage = "owned mock authority";
const runtimeErrors = [];
const rendererRequests = [];
const unexpected = [];
const calls = [];

function reply(response, value, status = 200) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
}
function enrollment() {
  return {
    secret: dummySeed,
    otpauthUri: `otpauth://totp/Synthetic:expiry?secret=${dummySeed}&issuer=Synthetic`,
    expiresAt: new Date(scenario.anchor + scenario.challengeMs).toISOString(),
    serverNow: new Date(scenario.anchor + scenario.elapsed).toISOString(),
  };
}
function session() {
  return {
    serverNow: new Date(scenario.anchor + scenario.elapsed).toISOString(),
    idleExpiresAt: new Date(scenario.anchor + scenario.idleMs).toISOString(),
    absoluteExpiresAt: new Date(
      scenario.anchor + scenario.absoluteMs,
    ).toISOString(),
  };
}
function identity() {
  return {
    user: {
      id: "synthetic:private-expiry",
      username: "synthetic.expiry",
      roles: ["Admin"],
      name: "Synthetic Expiry",
    },
    session: session(),
    needsBackupAcknowledgement: true,
  };
}
function authentication() {
  return {
    token: "synthetic-expiry-token",
    ...identity(),
    backupCodes: [...dummyBackupCodes],
  };
}
const server = createServer((request, response) => {
  request.resume();
  const route = `${request.method} ${request.url}`;
  calls.push(route);
  switch (route) {
    case "GET /health":
      reply(response, {
        status: scenario?.healthDenied ? "unavailable" : "ok",
        database: scenario?.healthDenied ? "disconnected" : "connected",
      });
      return;
    case "GET /setup/status":
      reply(response, { available: false });
      return;
    case "POST /auth/login":
      reply(response, {
        kind: "enroll",
        challenge: "synthetic-expiry-challenge",
        expiresAt: enrollment().expiresAt,
        serverNow: enrollment().serverNow,
      });
      return;
    case "POST /mfa/enroll":
      if (scenario.holdEnrollment) scenario.enrollmentResponse = response;
      else reply(response, enrollment());
      return;
    case "POST /mfa/complete":
      if (scenario.holdAuthentication)
        scenario.authenticationResponse = response;
      else reply(response, authentication());
      return;
    case "GET /auth/session":
      scenario.sessionChecks += 1;
      if (scenario.holdSession) scenario.sessionResponse = response;
      else if (scenario.sessionDenied)
        reply(
          response,
          {
            error: {
              code: "session_revoked",
              message: "Sign in again to continue.",
            },
          },
          401,
        );
      else reply(response, identity());
      return;
    case "POST /auth/logout":
      reply(response, { signedOut: true });
      return;
    default:
      unexpected.push(route);
      reply(
        response,
        {
          error: {
            code: "fixture_refused",
            message: "Fixture refused action.",
          },
        },
        403,
      );
  }
});

async function launch(options = {}) {
  await client?.close();
  client = undefined;
  scenario = {
    anchor: Date.now(),
    elapsed: 0,
    challengeMs: 6000,
    idleMs: 6000,
    absoluteMs: 120_000,
    sessionChecks: 0,
    ...options,
  };
  client = await electron.launch({
    ...(executable
      ? { executablePath: executable, args: ["--demo-loopback"] }
      : { args: [root, "--demo-loopback"] }),
    env: { ...process.env, STAFF_API_URL: "http://127.0.0.1:4101" },
    timeout: 30_000,
  });
  page = await client.firstWindow();
  page.on("pageerror", () => runtimeErrors.push("renderer exception"));
  page.on("console", (message) => {
    if (
      message.type() === "error" ||
      /Electron Security Warning/i.test(message.text())
    )
      runtimeErrors.push("runtime/security warning");
  });
  page.on("request", (request) => {
    if (/^https?:/i.test(request.url()))
      rendererRequests.push("external renderer request");
  });
  await page.getByRole("heading", { name: "Sign in to Cedar Staff" }).waitFor();
  await page.clock.install({ time: new Date(scenario.anchor) });
  await page.clock.pauseAt(new Date(scenario.anchor + 5000));
  await page.clock.setSystemTime(new Date(scenario.anchor));
  // Reload after installing the clock so React's authority/deadline intervals
  // are created under controlled time rather than before clock interception.
  await page.reload();
  await page.getByRole("heading", { name: "Sign in to Cedar Staff" }).waitFor();
  await page.getByLabel("Username", { exact: true }).fill("synthetic.expiry");
  await page
    .getByLabel("Password or passphrase")
    .fill("Synthetic expiry fixture only");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .getByRole("heading", { name: "Connect your authenticator" })
    .waitFor();
}
async function enrollmentShown() {
  await page.locator(".staff-private-key").waitFor();
  await page.getByAltText("Private authenticator enrollment QR code").waitFor();
}
async function assertNoPrivateDisplay() {
  assert.equal(await page.locator(".staff-private-key").count(), 0);
  assert.equal(await page.locator(".staff-enrollment img").count(), 0);
  assert.equal(await page.locator(".staff-backup-codes").count(), 0);
  assert.equal(
    await page.getByLabel("Authenticator code", { exact: true }).count(),
    0,
  );
  assert.deepEqual(
    savedFactors,
    factorSnapshot,
    "Display expiry altered fixture factors",
  );
}
async function signInReturned(expired = true) {
  await page
    .getByRole("heading", { name: "Sign in to Cedar Staff" })
    .waitFor({ timeout: 3000 });
  await assertNoPrivateDisplay();
  assert.ok(
    await page
      .getByRole("heading", { name: "Sign in to Cedar Staff" })
      .evaluate((element) => element === document.activeElement),
    "Focus did not return to the sign-in heading",
  );
  if (expired) {
    const message = await page.getByRole("alert").textContent();
    if (!/expired/i.test(message)) {
      const category = /unavailable/i.test(message)
        ? "unavailable"
        : /sign in again/i.test(message)
          ? "sign-in-again"
          : "other";
      console.error(`Safe message category: ${category}`);
    }
    assert.match(message, /expired/i);
  }
}
async function narrowWindow() {
  await client.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(360, 850),
  );
  await page.waitForFunction(() => Math.abs(innerWidth - 360) < 3);
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
    "Narrow private screen overflows horizontally",
  );
}
async function backupShown() {
  await enrollmentShown();
  await page.getByLabel("Authenticator code", { exact: true }).fill("000000");
  assert.equal(
    await page.getByLabel("Authenticator code", { exact: true }).inputValue(),
    "000000",
    "Deadline capture checks must not overwrite typed codes",
  );
  await page.getByRole("button", { name: "Verify and continue" }).click();
  await page.getByRole("heading", { name: "Save your backup codes" }).waitFor();
  assert.equal(
    await page.locator(".staff-backup-codes li").count(),
    dummyBackupCodes.length,
  );
}
function pass(name) {
  completed += 1;
  console.log(`PASS ${completed}: ${name}`);
}
async function releaseDelayed(response, value) {
  assert.ok(response, "The expected mock request did not begin");
  reply(response, value);
  await advance(100);
  // Let the Node/Electron IPC complete without relying on frozen renderer timers.
  await new Promise((resolve) => setTimeout(resolve, 100));
}
async function advance(milliseconds) {
  scenario.elapsed += milliseconds;
  await page.clock.runFor(milliseconds);
}
async function wakeAt(milliseconds) {
  scenario.elapsed = milliseconds;
  await page.clock.setSystemTime(new Date(scenario.anchor + milliseconds));
  await page.evaluate(() => {
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("pageshow"));
  });
}
async function waitForMock(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(predicate(), "The expected synthetic request did not begin");
}
async function healthStillAvailable() {
  const response = await fetch("http://127.0.0.1:4101/health");
  assert.equal((await response.json()).status, "ok");
}

try {
  // EADDRINUSE fails without touching the existing listener.
  server.listen(4101, "127.0.0.1");
  await once(server, "listening");

  stage = "healthy authority enrollment deadline";
  await launch();
  await enrollmentShown();
  await narrowWindow();
  await page.getByLabel("Authenticator code", { exact: true }).fill("000000");
  assert.equal(
    await page.getByLabel("Authenticator code", { exact: true }).inputValue(),
    "000000",
    "Deadline capture checks must not overwrite typed codes",
  );
  await advance(6001);
  await signInReturned();
  await healthStillAvailable();
  pass(
    "enrollment seed, QR and entered code disappear at original deadline with healthy authority",
  );

  stage = "delayed timers and suspension wake";
  await launch();
  await enrollmentShown();
  await wakeAt(9000);
  await signInReturned();
  pass("wake checks actual deadline even when timer callbacks have not run");

  stage = "delayed enrollment response after expiry";
  await launch({ holdEnrollment: true });
  await waitForMock(() => scenario.enrollmentResponse);
  await advance(6001);
  await signInReturned();
  await releaseDelayed(scenario.enrollmentResponse, enrollment());
  await signInReturned();
  pass("late enrollment response cannot restore expired seed or QR");

  stage = "delayed enrollment response after cancellation";
  await launch({ holdEnrollment: true });
  await waitForMock(() => scenario.enrollmentResponse);
  await page
    .getByRole("button", { name: "Cancel and return to sign in" })
    .click();
  await signInReturned(false);
  await releaseDelayed(scenario.enrollmentResponse, enrollment());
  await signInReturned(false);
  pass("late enrollment response cannot restore cancelled seed or QR");

  stage = "delayed enrollment response after authority loss";
  await launch({ holdEnrollment: true, challengeMs: 60_000 });
  await waitForMock(() => scenario.enrollmentResponse);
  scenario.healthDenied = true;
  await advance(15_001);
  await page
    .getByRole("heading", { name: "Local staff server unavailable" })
    .waitFor();
  await releaseDelayed(scenario.enrollmentResponse, enrollment());
  await assertNoPrivateDisplay();
  assert.equal(
    await page
      .getByRole("heading", { name: "Local staff server unavailable" })
      .count(),
    1,
  );
  pass("authority loss clears enrollment and rejects delayed secret responses");

  stage = "backup screen session expiry";
  await launch({ challengeMs: 60_000 });
  await backupShown();
  await advance(6001);
  await signInReturned();
  await healthStillAvailable();
  pass(
    "backup-code list disappears at session deadline without acknowledging or replacing factors",
  );

  stage = "backup absolute deadline";
  await launch({ challengeMs: 60_000, idleMs: 60_000, absoluteMs: 6000 });
  await backupShown();
  await advance(6001);
  await signInReturned();
  pass(
    "backup-code screen obeys absolute deadline even when idle deadline is later",
  );

  stage = "backup suspension wake";
  await launch({ challengeMs: 60_000 });
  await backupShown();
  await narrowWindow();
  await wakeAt(9000);
  await signInReturned();
  pass(
    "narrow backup screen checks actual deadline on suspension wake without timer callbacks",
  );

  stage = "backup screen current server authorization";
  await launch({ challengeMs: 60_000, idleMs: 60_000, sessionDenied: true });
  await backupShown();
  await advance(15_001);
  await signInReturned(false);
  assert.ok(
    scenario.sessionChecks > 0,
    "Backup screen did not check server session",
  );
  pass(
    "backup screen polls current authorization and clears codes on revocation while health succeeds",
  );

  stage = "delayed authentication response after enrollment expiry";
  await launch({ holdAuthentication: true });
  await enrollmentShown();
  await page.getByLabel("Authenticator code", { exact: true }).fill("000000");
  assert.equal(
    await page.getByLabel("Authenticator code", { exact: true }).inputValue(),
    "000000",
    "Deadline capture checks must not overwrite typed codes",
  );
  await page.getByRole("button", { name: "Verify and continue" }).click();
  await waitForMock(() => scenario.authenticationResponse);
  await advance(6001);
  await signInReturned();
  await releaseDelayed(scenario.authenticationResponse, authentication());
  await signInReturned();
  pass(
    "late successful MFA response cannot restore expired backup display or access",
  );

  stage = "delayed session response after backup expiry";
  await launch({ challengeMs: 60_000, idleMs: 20_000, holdSession: true });
  await backupShown();
  await advance(15_001);
  await waitForMock(() => scenario.sessionResponse);
  assert.ok(
    scenario.sessionResponse,
    "Expected session poll before local expiry",
  );
  await advance(5001);
  await signInReturned();
  await releaseDelayed(scenario.sessionResponse, identity());
  await signInReturned();
  pass("late session response cannot reopen expired backup-code display");

  assert.deepEqual(runtimeErrors, [], "Runtime/security errors");
  assert.deepEqual(rendererRequests, [], "External renderer requests");
  assert.deepEqual(unexpected, [], "Unexpected operational/delivery action");
  assert.equal(
    calls.includes("POST /auth/activity"),
    false,
    "Background checks renewed activity",
  );
  assert.equal(
    calls.includes("POST /mfa/acknowledge"),
    false,
    "Display expiry acknowledged backups",
  );
  pass(
    "mock factors unchanged; no activity renewal, acknowledgement, database access, delivery or renderer internet requests",
  );
  console.log(
    `Completed ${completed} private-screen checks (${executable ? "packaged" : "development"}).`,
  );
} catch (error) {
  // Safe stage only; Playwright errors may contain private DOM values.
  const line = error.stack?.match(/verify-private-expiry\.js:(\d+):/)?.[1];
  console.error(
    `FAIL: ${stage} (${error.name}, verifier line ${line ?? "unknown"}, code ${error.code ?? "none"}). No secret-bearing diagnostics were printed.`,
  );
  process.exitCode = 1;
} finally {
  await client?.close();
  if (server.listening) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
