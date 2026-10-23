import assert from "node:assert/strict";
import { createServer, request as proxyRequest } from "node:http";
import { once } from "node:events";
import { resolve, relative, isAbsolute, sep } from "node:path";
import { mkdir, open, access, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { _electron as electron, chromium } from "playwright";
import { readLauncherConfig } from "../../staff-api/scripts/launcher/configuration.js";
import { seedPublicationAuthority } from "../../staff-api/test/helpers/publication-authority.js";
import { startPublicationProcess } from "../../staff-api/test/helpers/publication-process.js";
import { verifySyntheticManager } from "./operational-review-controls.js";

const args = process.argv.slice(2),
  interactive = args.includes("--interactive"),
  packageIndex = args.indexOf("--package");
const executable =
  packageIndex < 0 ? undefined : resolve(args[packageIndex + 1]);
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
await access(resolve("apps/web/dist/index.html"));
const roles = [
  "Admin",
  "System Admin",
  "Clinic Admin",
  "Lab Admin",
  "Clinic Receptionist",
  "Lab Receptionist",
];
let selectedRole = "Admin",
  fixture,
  setup,
  lock,
  staffProxy,
  publicProxy,
  staff,
  receiver,
  client,
  browser,
  page,
  site,
  ticker,
  lastTick,
  streamId,
  commandBusy = false;
const people = new Map(),
  errors = [],
  external = [],
  token = randomBytes(32).toString("base64url");
let checkpoints = 0,
  stage = "preflight";
const evidence = resolve(".local/public-publication-review"),
  lockPath = resolve(".local/professional-schedule-review/review.lock");
const pass = (text) => console.log(`PASS ${++checkpoints}: ${text}`);
const today = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Beirut",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
const addDays = (date, days) => {
  const at = new Date(`${date}T12:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
};
function makeProxy(kind) {
  return createServer((request, response) => {
    const target = kind === "staff" ? staff : receiver;
    if (!target) {
      response.writeHead(503, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      response.end(
        JSON.stringify({
          error:
            kind === "staff"
              ? {
                  code: "AUTHORITY_UNAVAILABLE",
                  message: "Owned TEST staff service is unavailable.",
                }
              : "publication_unavailable",
        }),
      );
      return;
    }
    const outgoing = proxyRequest(
      {
        hostname: "127.0.0.1",
        port: target.port,
        path: request.url,
        method: request.method,
        headers: { ...request.headers, host: `127.0.0.1:${target.port}` },
        timeout: 7000,
      },
      (incoming) => {
        response.writeHead(incoming.statusCode, incoming.headers);
        incoming.pipe(response);
      },
    );
    outgoing.on("timeout", () => outgoing.destroy());
    outgoing.on("error", () => {
      if (!response.headersSent)
        response.writeHead(503, { "Content-Type": "application/json" });
      response.end('{"error":"owned_test_service_unavailable"}');
    });
    request.pipe(outgoing);
  });
}
async function setReceiver(enabled) {
  if (!enabled) {
    const own = receiver;
    receiver = null;
    await own?.stop();
  } else if (!receiver)
    receiver = await startPublicationProcess({
      mode: "receiver",
      streamId,
      token,
      website: true,
    });
}
async function setStaff(enabled) {
  if (!enabled) {
    const own = staff;
    staff = null;
    await own?.stop();
  } else if (!staff)
    staff = await startPublicationProcess({
      mode: "staff",
      token,
      target: "http://127.0.0.1:4201/api/publications",
      clockAt: +fixture.clock(),
    });
}
async function freshCode(person) {
  const deadline = Date.now() + 35000;
  while (Date.now() < deadline) {
    const record = await fixture.db
      .collection("accounts")
      .findOne({ _id: person.id });
    if (Math.floor(+fixture.clock() / 30000) > record.mfa.lastAcceptedStep)
      return fixture.totp(person.secret);
    await delay(150);
  }
  throw new Error(
    "A fresh synthetic MFA step was not available; no replay state was changed.",
  );
}
async function openClient(role) {
  if (!staff)
    throw new Error("Start the owned TEST staff service first: staff on");
  if (!roles.includes(role)) throw new Error("Use an exact listed role.");
  if (page && !page.isClosed() && (await page.getByRole("dialog").count()))
    throw new Error(
      "Save/cancel the current dialog first; no draft was discarded.",
    );
  await client?.close();
  selectedRole = role;
  client = await electron.launch({
    ...(executable
      ? { executablePath: executable, args: ["--demo-loopback"] }
      : { args: [resolve("apps/staff"), "--demo-loopback"] }),
    env: { ...process.env, STAFF_API_URL: "http://127.0.0.1:4101" },
    timeout: 30000,
  });
  page = await client.firstWindow();
  page.setDefaultTimeout(15000);
  page.on("pageerror", () => errors.push("staff renderer exception"));
  page.on("console", (m) => {
    if (m.type() === "error" || /Electron Security Warning/i.test(m.text()))
      errors.push("staff runtime/security error");
  });
  page.on("request", (r) => {
    if (/^https?:/i.test(r.url()))
      external.push("staff renderer external request");
  });
  const person = people.get(role);
  await page
    .getByRole("heading", { name: "Sign in to Cedar Staff", exact: true })
    .waitFor();
  await page.getByLabel("Username", { exact: true }).fill(person.username);
  await page
    .getByLabel("Password or passphrase", { exact: true })
    .fill(person.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  if (person.secret) {
    await page
      .getByLabel("Authenticator code", { exact: true })
      .fill(await freshCode(person));
    await page
      .getByRole("button", { name: "Verify and continue", exact: true })
      .click();
  }
  await page
    .getByRole("heading", { name: "Staff workspace", exact: true })
    .waitFor();
}
async function verify() {
  await verifySyntheticManager({
    page,
    person: people.get(selectedRole),
    nextCode: () => freshCode(people.get(selectedRole)),
  });
}
async function until(check, label, milliseconds = 20000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(200);
  }
  throw new Error(label);
}
async function refreshDelivery(sequence, expected = "Receiver accepted") {
  await until(
    async () => {
      const refresh = page.getByRole("button", {
        name: "Refresh delivery status",
        exact: true,
      });
      if (await refresh.isEnabled()) await refresh.click();
      const row = page
        .getByRole("heading", { name: `Publication ${sequence}`, exact: true })
        .locator("xpath=ancestor::li[1]");
      return (await row.count()) && (await row.innerText()).includes(expected);
    },
    `Publication ${sequence} did not reach expected delivery state`,
    25000,
  );
}
async function editName(name) {
  await page
    .getByRole("button", { name: "Professionals", exact: true })
    .click();
  const target = page
    .getByRole("button", { name: /^Edit Dr\. Synthetic/ })
    .first();
  await target.click();
  await page
    .getByLabel("Professional name and actual title", { exact: true })
    .fill(name);
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "detached" });
}
async function publish(date = today()) {
  await page
    .getByRole("button", { name: "Review publication", exact: true })
    .click();
  await page.getByLabel("Synthetic Review Clinic", { exact: true }).check();
  await page
    .getByLabel("Effective from (Asia/Beirut)", { exact: true })
    .fill(date);
  await page.getByLabel(/I reviewed these drafts/).check();
  await page
    .getByRole("button", { name: "Publish selected drafts", exact: true })
    .click();
  await page.getByRole("dialog").waitFor({ state: "detached" });
}
async function noOverflow(target) {
  assert.equal(
    await target.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
}
async function interactiveLoop() {
  console.log(
    "TEST ONLY: generated synthetic accounts, no private credentials. Commands: verify | role <exact role> | reopen | site | receiver off/on | staff off/on | status | quit. Same-run edits persist; quit clears expendable TEST fixtures. Do NOT run any staff TEST suite concurrently. Website: http://127.0.0.1:4201",
  );
  const terminal = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  await new Promise((resolve) => {
    terminal.on("line", async (line) => {
      if (commandBusy) return console.log("Wait for the current TEST command.");
      commandBusy = true;
      try {
        const command = line.trim();
        if (command === "quit") terminal.close();
        else if (command === "verify") {
          await verify();
          console.log(
            "Synthetic verification completed through the real dialog.",
          );
        } else if (command === "reopen") {
          await openClient(selectedRole);
          console.log(
            "Owned TEST application reopened; review edits preserved.",
          );
        } else if (command.startsWith("role ")) {
          await openClient(command.slice(5));
          console.log(
            `Signed in as synthetic ${selectedRole}; review edits preserved.`,
          );
        } else if (command === "site")
          await site.goto("http://127.0.0.1:4201/doctors");
        else if (["receiver off", "receiver on"].includes(command)) {
          await setReceiver(command.endsWith("on"));
          console.log(
            `Owned TEST receiver ${receiver ? "running" : "stopped"}; accepted data preserved.`,
          );
        } else if (["staff off", "staff on"].includes(command)) {
          await setStaff(command.endsWith("on"));
          console.log(
            `Owned TEST staff API ${staff ? "running" : "stopped"}; review edits preserved.`,
          );
        } else if (command === "status")
          console.log(
            `Owned staff: ${staff ? "running" : "stopped"}; owned receiver: ${receiver ? "running" : "stopped"}. Shared services untouched.`,
          );
        else
          console.log(
            `Commands: verify | role <${roles.join(" / ")}> | reopen | site | receiver off/on | staff off/on | status | quit`,
          );
      } catch {
        console.log(
          "TEST command refused or unavailable. Check role, open dialog and owned-service status; no secrets printed and review data not reset.",
        );
      } finally {
        commandBusy = false;
      }
    });
    terminal.on("close", () => {
      process.stdin.pause();
      resolve();
    });
  });
}
try {
  await mkdir(evidence, { recursive: true });
  await mkdir(resolve(lockPath, ".."), { recursive: true });
  lock = await open(lockPath, "wx");
  staffProxy = makeProxy("staff");
  publicProxy = makeProxy("public");
  // Reserve BOTH fixed review ports before connecting/resetting TEST fixtures.
  staffProxy.listen(4101, "127.0.0.1");
  await once(staffProxy, "listening");
  publicProxy.listen(4201, "127.0.0.1");
  await once(publicProxy, "listening");
  process.env.CAPSTONE_STAFF_RUNTIME_DIR = (
    await readLauncherConfig()
  ).runtimeDirectory;
  // Runtime selection must precede importing the protected-key consumer.
  const { createSecurityFixture } =
    await import("../../staff-api/test/helpers/security-fixture.js");
  fixture = await createSecurityFixture({
    publicationDeliveryConfigured: true,
  });
  await fixture.reset();
  setup = await seedPublicationAuthority(fixture, "review.publication.admin");
  people.set("Admin", setup.admin);
  await setup.save("professionals", {
    ...setup.profile,
    id: "specialist:synthetic",
    kind: "specialist",
    name: "Synthetic Review Therapist",
    specialty: "Therapist",
  });
  await setup.save("scopes", {
    id: "service:audio",
    name: "Audiometry",
    kind: "service",
    active: true,
  });
  const day = new Date(`${today()}T12:00:00Z`).getUTCDay();
  for (const weekday of new Set([1, ...(day ? [day] : [])])) {
    if (weekday !== 1)
      await setup.save("sessions", {
        id: `session:today:${weekday}`,
        scopeId: "clinic:synthetic",
        professionalId: setup.profile.id,
        weekday,
        startTime: "09:00",
        endTime: "11:00",
        capacity: 5,
        status: "active",
        appointmentRequired: false,
      });
    await setup.save("sessions", {
      id: `session:therapist:${weekday}`,
      scopeId: "clinic:synthetic",
      professionalId: "specialist:synthetic",
      weekday,
      startTime: "10:00",
      endTime: "11:00",
      capacity: 3,
      status: "active",
      appointmentRequired: true,
    });
    await setup.save("sessions", {
      id: `session:audio:${weekday}`,
      scopeId: "service:audio",
      professionalId: null,
      weekday,
      startTime: "09:00",
      endTime: "13:00",
      capacity: null,
      status: "active",
      appointmentRequired: false,
    });
  }
  for (const role of roles.slice(1)) {
    const person = await fixture.account({
      username: `review.publication.${role.toLowerCase().replaceAll(" ", ".")}`,
      roles: [role],
      mfa: !role.includes("Receptionist"),
    });
    people.set(role, person);
    if (role !== "System Admin")
      setup.ok(
        await setup.post("grants", {
          accountId: person.id,
          scopeIds: [
            role.startsWith("Clinic") ? "clinic:synthetic" : "service:audio",
          ],
          expectedRevision: 0,
          confirmed: true,
        }),
      );
  }
  setup.ok(
    await setup.publish("2026-01-01", ["clinic:synthetic", "service:audio"]),
  );
  streamId = (
    await fixture.db.collection("operational_state").findOne({ _id: "working" })
  ).streamId;
  await fixture.stopServer();
  lastTick = Date.now();
  ticker = setInterval(() => {
    const now = Date.now();
    fixture.advance(now - lastTick);
    lastTick = now;
  }, 250);
  await setReceiver(true);
  await setStaff(true);
  browser = await chromium.launch({
    channel: "msedge",
    headless: !interactive,
  });
  site = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  site.setDefaultTimeout(15000);
  site.on("pageerror", () => errors.push("website exception"));
  site.on("request", (r) => {
    if (
      /^https?:/i.test(r.url()) &&
      new URL(r.url()).origin !== "http://127.0.0.1:4201"
    )
      external.push("website external request");
  });
  await openClient("Admin");
  if (interactive) {
    await site.goto("http://127.0.0.1:4201/doctors");
    await interactiveLoop();
  } else {
    stage = "baseline website";
    await until(
      async () => (await fetch("http://127.0.0.1:4201/api/professionals")).ok,
      "Baseline delivery did not complete",
    );
    await site.goto("http://127.0.0.1:4201/doctors");
    await site
      .getByRole("heading", { name: setup.profile.name, exact: true })
      .waitFor();
    await site
      .getByRole("heading", { name: "Synthetic Review Therapist", exact: true })
      .waitFor();
    pass(
      "actual website directory reads accepted doctors AND specialists from persistent receiver",
    );
    stage = "draft isolation";
    const revised = "Dr. Synthetic Published Review";
    await editName(revised);
    await site.reload();
    await site
      .getByRole("heading", { name: setup.profile.name, exact: true })
      .waitFor();
    assert.equal(
      await site.getByRole("heading", { name: revised, exact: true }).count(),
      0,
    );
    pass("actual app draft save does not change the actual website");
    stage = "app publish";
    await publish();
    await refreshDelivery(2);
    await site.reload();
    await site.getByRole("heading", { name: revised, exact: true }).waitFor();
    pass(
      "actual Electron Publish -> IPC -> TEST staff transaction/outbox -> authenticated receiver -> browser",
    );
    for (const path of ["/", "/schedule"]) {
      await site.goto(`http://127.0.0.1:4201${path}`);
      if (day)
        await site
          .getByRole("heading", { name: revised, exact: true })
          .waitFor();
      await noOverflow(site);
    }
    pass(
      "Home and Schedule use the same accepted source; stable session/professional contracts preserved",
    );
    stage = "future timeline";
    const futureName = "Dr. Synthetic Future Review",
      futureDate = addDays(today(), 7);
    await editName(futureName);
    await publish(futureDate);
    await refreshDelivery(3);
    await site.goto("http://127.0.0.1:4201/doctors");
    await site.getByRole("heading", { name: revised, exact: true }).waitFor();
    assert.equal(
      await site
        .getByRole("heading", { name: futureName, exact: true })
        .count(),
      0,
    );
    await site.goto("http://127.0.0.1:4201/schedule");
    await site.getByRole("button", { name: "Next week", exact: true }).click();
    if (day)
      await site
        .getByRole("heading", { name: futureName, exact: true })
        .waitFor();
    pass(
      "accepted future publication stays out of current directory/Home and appears on its future Schedule day",
    );
    stage = "receiver outage";
    await setReceiver(false);
    await editName("Dr. Synthetic Retry Review");
    await publish();
    await refreshDelivery(4, "Delivery failed");
    await setReceiver(true);
    await page
      .getByRole("button", {
        name: "Retry delivery for publication 4",
        exact: true,
      })
      .click();
    await refreshDelivery(4);
    await site.goto("http://127.0.0.1:4201/doctors");
    await site
      .getByRole("heading", { name: "Dr. Synthetic Retry Review", exact: true })
      .waitFor();
    pass(
      "owned receiver outage retains committed work; authorized retry updates website without rebuilding it",
    );
    stage = "staff outage";
    await setStaff(false);
    await site.reload();
    await site
      .getByRole("heading", { name: "Dr. Synthetic Retry Review", exact: true })
      .waitFor();
    pass(
      "fresh browser read remains available while the only owned staff API is stopped",
    );
    await setStaff(true);
    await openClient("Admin");
    await page
      .getByRole("button", { name: "Professionals", exact: true })
      .click();
    await refreshDelivery(4);
    pass(
      "owned staff API restart retains delivery state and publications without reseeding",
    );
    await page.screenshot({
      path: resolve(
        evidence,
        `${executable ? "packaged" : "development"}-staff-desktop.png`,
      ),
      fullPage: true,
    });
    await site.screenshot({
      path: resolve(
        evidence,
        `${executable ? "packaged" : "development"}-website-desktop.png`,
      ),
      fullPage: true,
    });
    await page.setViewportSize({ width: 360, height: 760 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await noOverflow(page);
    await site.setViewportSize({ width: 360, height: 760 });
    await site.emulateMedia({ reducedMotion: "reduce" });
    await noOverflow(site);
    await page
      .getByRole("button", { name: /^Edit Dr\. Synthetic/ })
      .first()
      .click();
    await page.keyboard.press("Shift+Tab");
    assert.equal(
      await page.evaluate(() =>
        document
          .querySelector('[role="dialog"]')
          .contains(document.activeElement),
      ),
      true,
    );
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "detached" });
    pass(
      "narrow layouts/reduced motion; editor focus containment and Escape preserved",
    );
    await page.screenshot({
      path: resolve(
        evidence,
        `${executable ? "packaged" : "development"}-staff.png`,
      ),
      fullPage: true,
    });
    await site.screenshot({
      path: resolve(
        evidence,
        `${executable ? "packaged" : "development"}-website.png`,
      ),
      fullPage: true,
    });
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    pass(
      "no JS renderer exceptions, Electron security errors or external website/renderer requests",
    );
  }
} catch (error) {
  console.error(
    `FAIL at ${stage}: ${error.name}; ${String(error.message)
      .split("\n")[0]
      .replace(
        /review\.[A-Za-z.]+/g,
        "synthetic",
      )}. No secret inputs or payloads printed.`,
  );
  process.exitCode = 1;
} finally {
  clearInterval(ticker);
  await client?.close().catch(() => {});
  await browser?.close().catch(() => {});
  await setStaff(false).catch(() => {
    process.exitCode = 1;
  });
  await setReceiver(false).catch(() => {
    process.exitCode = 1;
  });
  for (const proxy of [staffProxy, publicProxy])
    if (proxy?.listening) {
      proxy.closeAllConnections();
      await new Promise((resolve) => proxy.close(resolve));
    }
  if (fixture) {
    try {
      await fixture.reset();
    } catch {
      console.error(
        "Owned TEST cleanup failed; no development cleanup attempted.",
      );
      process.exitCode = 1;
    } finally {
      await fixture.close();
    }
  }
  if (lock) {
    await lock.close();
    await unlink(lockPath);
  }
}
