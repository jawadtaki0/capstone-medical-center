// Isolated actual website -> staff confirmation -> queue acceptance. No hosted/normal fallback.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { resolve, relative, isAbsolute, sep } from "node:path";
import { mkdir, open, unlink, access, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import { _electron as electron, chromium } from "playwright";
import { readLauncherConfig } from "../../staff-api/scripts/launcher/configuration.js";

const args = process.argv.slice(2),
  interactive = args.includes("--interactive"),
  uiEvidence = args.includes("--ui-evidence");
const packageIndex = args.indexOf("--package");
assert.ok(packageIndex >= 0, "Select the exact review package with --package.");
const executable = resolve(args[packageIndex + 1]);
const path = relative(resolve("apps/staff/release"), executable);
assert.ok(
  path &&
    !path.startsWith(`..${sep}`) &&
    !isAbsolute(path) &&
    path.endsWith(".exe"),
);
await access(executable);
const evidence = resolve(
    uiEvidence
      ? ".local/queue-ui-evidence-2026-11-03"
      : ".local/queue-acceptance",
  ),
  lockPath = resolve(".local/professional-schedule-review/review.lock");
let lock,
  fixture,
  proxy,
  publicServer,
  desktop,
  browser,
  page,
  web,
  stage = "exclusive TEST ownership",
  checks = 0;
let loseArrival = false;
const arrivalRequests = [],
  errors = [];
const good = (r) => {
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
};
const pass = (message) => console.log(`PASS ${++checks}: ${message}`);
try {
  await mkdir(evidence, { recursive: true });
  await mkdir(resolve(".local/professional-schedule-review"), {
    recursive: true,
  });
  lock = await open(lockPath, "wx");
  await lock.writeFile(
    JSON.stringify({ pid: process.pid, kind: "queue-full-acceptance-TEST" }),
  );
  proxy = createServer(async (req, res) => {
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 16384) throw Error("Oversize TEST request");
        chunks.push(chunk);
      }
      const body = size
        ? JSON.parse(Buffer.concat(chunks).toString())
        : undefined;
      const result = await fixture.request(req.url, {
        method: req.method,
        token: req.headers.authorization?.replace(/^Bearer /, ""),
        ...(body ? { body } : {}),
      });
      if (req.url === "/queue/checkIn") {
        arrivalRequests.push(body);
        if (loseArrival && result.status === 200) {
          loseArrival = false;
          res.destroy();
          return;
        }
      }
      res.writeHead(result.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result.body));
    } catch {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            code: "authority_unavailable",
            message: "Owned TEST request failed. Refresh or retry.",
          },
        }),
      );
    }
  });
  proxy.listen(4101, "127.0.0.1");
  await once(proxy, "listening");
  process.env.CAPSTONE_STAFF_RUNTIME_DIR = (
    await readLauncherConfig()
  ).runtimeDirectory;
  delete process.env.STAFF_SETUP_TEST_MEMORY;
  const { createSecurityFixture } =
    await import("../../staff-api/test/helpers/security-fixture.js");
  const { seedPublicationAuthority } =
    await import("../../staff-api/test/helpers/publication-authority.js");
  const { createRequestTransport } =
    await import("../../staff-api/src/request-integration.js");
  const { beirutClock } = await import("../../staff-api/src/booking-model.js");
  const credential = randomBytes(32).toString("base64url");
  const config = {
    mode: "test",
    key: randomBytes(32),
    credential,
    target: "http://127.0.0.1:5191/api/requests/integration",
    publicBase: "http://127.0.0.1:5191",
    contact: "SYNTHETIC TEST ONLY",
  };
  config.transport = createRequestTransport(config);
  stage = "guarded TEST setup";
  fixture = await createSecurityFixture({ requestIntegration: config });
  await fixture.reset();
  const next = new Date(`${beirutClock(fixture.clock()).date}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + ((8 - next.getUTCDay()) % 7 || 7));
  const date = next.toISOString().slice(0, 10),
    laterDate = new Date(+next + 7 * 86400000).toISOString().slice(0, 10);
  fixture.advance(new Date(`${date}T10:59:00+02:00`) - fixture.clock());
  const authority = await seedPublicationAuthority(fixture);
  await authority.save("professionals", {
    ...authority.profile,
    id: "doctor:second",
    name: "Dr. Synthetic Second",
  });
  for (const record of [
    {
      id: "session:second",
      professionalId: "doctor:second",
      startTime: "09:00",
      endTime: "11:00",
    },
    {
      id: "session:afternoon",
      professionalId: "doctor:synthetic",
      startTime: "13:00",
      endTime: "15:00",
    },
  ])
    await authority.save("sessions", {
      ...record,
      scopeId: "clinic:synthetic",
      weekday: 1,
      capacity: 4,
      status: "active",
      appointmentRequired: false,
    });
  good(await authority.publish(null));
  const actor = await fixture.account({
    roles: ["Receptionist"],
    username: "synthetic.queue.acceptance",
  });
  await fixture.db.collection("operational_grants").insertOne({
    _id: actor.id,
    id: actor.id,
    scopeIds: ["clinic:synthetic"],
    revision: 1,
  });
  const patients = {};
  for (const label of [
    "Phoneone",
    "Phonetwo",
    "Phonelater",
    "Phonefuture",
    "Phonemissing",
    "Walkin",
    "Extra",
    "Full",
  ]) {
    const record = {
      firstName: label,
      fatherName: "Patient",
      lastName: "Synthetic",
      motherFirstName: "Mother",
      dateOfBirth: "2000-02-29",
      phone: "+96171123456",
      gender: "female",
    };
    const reviewed = good(
      await fixture.request("/patients/check", {
        method: "POST",
        token: authority.admin.token,
        body: { record },
      }),
    );
    patients[label] = good(
      await fixture.request("/patients/create", {
        method: "POST",
        token: authority.admin.token,
        body: {
          record,
          reviewDigest: reviewed.reviewDigest,
          duplicateOverride: {
            acknowledged: true,
            reason: "Distinct fictional acceptance patient",
          },
        },
      }),
    ).patient;
  }
  const { ensureIntakeIndexes, createPublicIntake } =
    await import("../../api/src/website-requests.js");
  const { createPublicationReceiver } =
    await import("../../api/src/publication-receiver.js");
  const { buildDelivery } =
    await import("../../../shared/publication-contract.mjs");
  const { createApp } = await import("../../api/src/app.js");
  await ensureIntakeIndexes(fixture.db);
  const state = await fixture.db
    .collection("operational_state")
    .findOne({ _id: "working" });
  const receiver = await createPublicationReceiver({
    db: fixture.db,
    client: fixture.client,
    token: credential,
    streamId: state.streamId,
    demoMode: true,
    environment: { mode: "test" },
  });
  const history = await fixture.db
    .collection("operational_publications")
    .find({})
    .sort({ sequence: 1 })
    .toArray();
  await receiver.accept(buildDelivery(state.streamId, history));
  const intake = createPublicIntake({
    db: fixture.db,
    client: fixture.client,
    key: config.key,
    clock: fixture.clock,
    sessionReader: (d) => receiver.requestSessions(d),
    professionalReader: (d) => receiver.requestProfessionals(d),
    upcomingReader: (input) => receiver.requestUpcoming(input),
  });
  publicServer = createApp({
    websiteDirectory: resolve(".local/queue-acceptance/web-build"),
    websiteRequests: { service: intake, credential },
    publicationReceiver: receiver,
  }).listen(5191, "127.0.0.1");
  await once(publicServer, "listening");
  browser = await chromium.launch({
    channel: "msedge",
    headless: !interactive && !uiEvidence,
  });
  const context = await browser.newContext({
    viewport: { width: 1400, height: 1000 },
  });
  await context.route("**/*", (route) => {
    const u = new URL(route.request().url());
    return /^https?:$/.test(u.protocol) && u.origin !== config.publicBase
      ? route.abort()
      : route.continue();
  });
  web = await context.newPage();
  await web.goto(`${config.publicBase}/request?date=${date}`);
  stage = "Edge upcoming-session discovery";
  const discovery = await web.evaluate(async (day) => {
    const url = `/api/requests/upcoming?professionalId=doctor%3Asynthetic&fromDate=${day}`;
    const response = await fetch(url);
    return {
      url: location.origin + url,
      status: response.status,
      body: await response.json(),
    };
  }, date);
  await writeFile(
    resolve(evidence, "edge-upcoming.json"),
    JSON.stringify(discovery, null, 2),
  );
  console.log(`Edge upcoming: ${discovery.status} ${discovery.url}`);
  assert.equal(discovery.status, 200, JSON.stringify(discovery.body));
  assert.ok(discovery.body.sessions.length > 0);
  async function launchDesktop() {
    desktop = await electron.launch({
      executablePath: executable,
      args: [
        "--demo-loopback",
        `--user-data-dir=${resolve(evidence, "profile")}`,
      ],
      env: { ...process.env, STAFF_API_URL: "http://127.0.0.1:4101" },
      timeout: 30000,
    });
    await desktop.evaluate(({ shell }) => {
      shell.openExternal = async () => {
        throw Error(
          "External messaging is outside this owned acceptance test.",
        );
      };
    });
    page = await desktop.firstWindow();
    page.setDefaultTimeout(15000);
    page.on("pageerror", () => errors.push("renderer exception"));
    page.on("console", (m) => {
      if (m.type() === "error" || /Electron Security Warning/.test(m.text()))
        errors.push("renderer/security error");
    });
    await page.getByLabel("Username", { exact: true }).fill(actor.username);
    await page
      .getByLabel("Password or passphrase", { exact: true })
      .fill(actor.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await desktop
      .browserWindow(page)
      .then((w) => w.evaluate((win) => win.setSize(1440, 1000)));
  }
  await launchDesktop();
  const nav = async (name) => {
    await page
      .getByRole("button", {
        name: name === "Website requests" ? /^Website requests/ : name,
        exact: name !== "Website requests",
      })
      .click();
    await page
      .getByRole("heading", {
        name: name === "Queue" ? "Patient queue" : name,
        exact: true,
      })
      .waitFor();
  };
  async function queue(
    professional = "doctor:synthetic",
    session = "session:synthetic",
    day = date,
  ) {
    await nav("Queue");
    await page
      .getByLabel("Session date (Asia/Beirut)", { exact: true })
      .fill(day);
    await page
      .getByRole("button", { name: /^(Load sessions|Refresh queue)$/ })
      .click();
    await page.locator('.queue-panel[aria-busy="false"]').waitFor();
    await page
      .getByLabel("Professional", { exact: true })
      .selectOption(professional);
    await page.locator('.queue-panel[aria-busy="false"]').waitFor();
    // Dated IDs are opaque; bind to the authoritative session option by displayed window instead.
    const window = session === "session:afternoon" ? "13:00" : "09:00";
    const option = await page
      .getByLabel("Session", { exact: true })
      .locator("option")
      .evaluateAll(
        (options, start) =>
          options.find((o) => o.textContent.includes(start))?.value,
        window,
      );
    assert.ok(option);
    await page.getByLabel("Session", { exact: true }).selectOption(option);
    await page.locator('.queue-panel[aria-busy="false"]').waitFor();
  }
  const booked = (name) =>
    page.locator(".queue-booked tbody tr").filter({ hasText: name });
  const waiting = (name) =>
    page.locator(".queue-waiting tbody tr").filter({ hasText: name });
  async function submitWebsite(first, professional) {
    await web.goto(`${config.publicBase}/request?date=${date}`);
    await web.getByLabel("Session date", { exact: true }).fill(date);
    await web
      .getByRole("combobox", { name: "Doctor or specialist", exact: true })
      .fill(professional);
    await web.getByRole("option", { name: new RegExp(professional) }).click();
    await web.getByRole("radio").first().check();
    await web.getByRole("button", { name: "Continue", exact: true }).click();
    for (const [label, value] of [
      ["First name", first],
      ["Fatherâ€™s name", "Patient"],
      ["Last name", "Synthetic"],
      ["Motherâ€™s maiden name", "Mother"],
      ["Date of birth", "2000-02-29"],
      ["Phone number", "71-123456"],
    ])
      await web.getByLabel(label, { exact: true }).fill(value);
    await web.getByLabel("Gender", { exact: true }).selectOption("female");
    await web.getByRole("button", { name: "Continue", exact: true }).click();
    await web
      .getByRole("button", { name: "Submit request", exact: true })
      .click();
    await web
      .getByRole("heading", { name: "Request received", exact: true })
      .waitFor();
    return (
      await web.locator(".request-receipt strong").first().innerText()
    ).trim();
  }
  async function confirmWebsite(reference) {
    await nav("Website requests");
    await page
      .getByRole("button", { name: "Refresh requests", exact: true })
      .click();
    await page
      .getByRole("button", { name: `Review ${reference}`, exact: true })
      .first()
      .click();
    const dialog = page.getByRole("dialog");
    const confirm = dialog.getByRole("button", {
      name: "Confirm request",
      exact: true,
    });
    await confirm.waitFor();
    if (await confirm.isDisabled()) {
      await dialog
        .getByLabel(/^Private reason \/ discrepancy review/)
        .fill("Distinct fictional patient; all candidate details reviewed");
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
    }
    await dialog
      .getByRole("button", { name: "Confirm request", exact: true })
      .click();
    await dialog
      .getByRole("button", { name: "Confirm booking", exact: true })
      .click();
    await dialog.getByText("Confirmed", { exact: true }).waitFor();
    await page
      .getByRole("button", { name: "Close dialog", exact: true })
      .click();
  }
  async function phone(label, professional, start = "09:00", day = date) {
    await nav("Bookings");
    await page.getByLabel("First name", { exact: true }).fill(label);
    await page
      .getByRole("button", { name: "Search patients", exact: true })
      .click();
    await page
      .getByRole("button", {
        name: `Select ${patients[label].patientNumber}`,
        exact: true,
      })
      .click();
    await page
      .getByLabel("Session date (Asia/Beirut)", { exact: true })
      .fill(day);
    await page
      .getByRole("button", { name: "Load sessions", exact: true })
      .click();
    await page
      .getByLabel("Professional", { exact: true })
      .selectOption(professional);
    await page
      .locator(".booking-session")
      .filter({ hasText: start })
      .getByRole("radio")
      .check();
    await page
      .getByRole("button", { name: "Review booking", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Confirm booking", exact: true })
      .click();
    await page
      .getByRole("heading", { name: "Booking confirmed", exact: true })
      .waitFor();
  }
  async function manage(name, action, container = ".queue-waiting") {
    const row = page.locator(`${container} tbody tr`).filter({ hasText: name });
    await row.locator("summary").click();
    await row.getByRole("button", { name: action, exact: true }).click();
  }
  async function admit(label, extra = false) {
    await page
      .getByRole("button", {
        name: extra ? "Admit extra today" : "Accept walk-in",
        exact: true,
      })
      .click();
    if (extra) {
      await page
        .getByLabel("Reason for extra admission", { exact: true })
        .fill("Professional agreed to a fictional extra today");
      await page.getByLabel(/professional.*agreed/i).check();
    }
    await page
      .locator(".queue-admission")
      .getByLabel("First name", { exact: true })
      .fill(label);
    await page
      .locator(".queue-admission")
      .getByRole("button", { name: "Search patients", exact: true })
      .click();
    await page
      .getByRole("button", {
        name: `Choose patient ${patients[label].patientNumber}`,
        exact: true,
      })
      .click();

    await page
      .locator(".queue-admission")
      .getByRole("button", {
        name: extra ? "Admit extra today" : "Accept walk-in",
        exact: true,
      })
      .click();
    await page.locator(".queue-admission").waitFor({ state: "hidden" });
  }
  await writeFile(
    resolve(evidence, "ready.json"),
    JSON.stringify(
      {
        date,
        laterDate,
        package: executable,
        website: `${config.publicBase}/request?date=${date}`,
        staff: "http://127.0.0.1:4101",
        database: "capstone_staff_test",
        hosted: false,
        syntheticOnly: true,
      },
      null,
      2,
    ),
  );
  if (uiEvidence) {
    stage = "targeted agent-operated packaged UI evidence";
    const { exerciseQueueUI } = await import("./queue-ui-evidence.js");
    checks = await exerciseQueueUI({
      getPage: () => page,
      phone,
      queue,
      booked,
      waiting,
      manage,
      admit,
      evidence,
      date,
      laterDate,
      fixture,
      reopen: async () => {
        await desktop.close();
        desktop = null;
        await fixture.restart();
        await launchDesktop();
        await queue();
      },
    });
  } else if (interactive) {
    await queue();
    console.log(
      `QUEUE ACCEPTANCE READY. Actual local website http://127.0.0.1:5191/request?date=${date}; exact review package / TEST API4101, no normal activation. TEST time10:59. No bookings pre-seeded. Follow docs/QUEUE_FULL_PACKAGED_ACCEPTANCE.md. Type end + Enter to advance ONLY TEST to11:00 and reconcile; reopen + Enter restarts only this owned package/TEST API and preserves this review's records. Blank Enter closes both owned apps and TEST review.`,
    );
    const input = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      for await (const line of input) {
        if (!line.trim()) break;
        if (line.trim().toLowerCase() === "end") {
          fixture.advance(new Date(`${date}T11:00:00+02:00`) - fixture.clock());
          const result = await fixture.reconcileQueue();
          console.log(
            `TEST time11:00. ${result.marked} No-show(s) recorded. Refresh queue. Blank Enter closes review.`,
          );
        } else if (line.trim().toLowerCase() === "reopen") {
          await desktop.close();
          desktop = null;
          await fixture.restart();
          await launchDesktop();
          await queue();
          console.log(
            "Owned review package and TEST API reopened. Records preserved. Blank Enter closes review.",
          );
        }
      }
    } finally {
      input.close();
    }
  } else {
    stage = "actual website form and packaged confirmation";
    const a = await submitWebsite("Guestalpha", "Dr. Synthetic Review");
    await confirmWebsite(a);
    const b = await submitWebsite("Guestbeta", "Dr. Synthetic Second");
    await confirmWebsite(b);
    await submitWebsite("Guestpending", "Dr. Synthetic Review");
    pass(
      "Actual public website form submits two requests and packaged staff registry review confirms two real bookings; third remains unresolved",
    );
    stage = "actual packaged phone bookings";
    await phone("Phoneone", "doctor:synthetic");
    await phone("Phonetwo", "doctor:second");
    await phone("Phonelater", "doctor:synthetic", "13:00");
    await phone("Phonefuture", "doctor:synthetic", "09:00", laterDate);
    await phone("Phonemissing", "doctor:synthetic");
    const stored = await fixture.db.collection("bookings").find({}).toArray();
    assert.equal(stored.filter((b) => b.source === "website").length, 2);
    assert.equal(stored.filter((b) => b.source === "phone").length, 5);
    assert.equal(
      stored.some((b) => b.queue),
      false,
    );
    pass(
      "Five actual packaged phone bookings and two website-confirmed bookings reserve places without checking anyone in",
    );
    await queue();
    assert.equal(await page.locator(".queue-booked tbody button").count(), 3);
    assert.match(await booked("Guestalpha").innerText(), /Website booking/);
    assert.match(await booked("Phoneone").innerText(), /Phone booking/);
    assert.equal(await booked("Guestpending").count(), 0);
    assert.equal(await booked("Guestbeta").count(), 0);
    await page.screenshot({
      path: resolve(evidence, "booked-list.png"),
      fullPage: true,
    });
    await queue("doctor:second", "session:second");
    assert.equal(await page.locator(".queue-booked tbody button").count(), 2);
    assert.equal(await booked("Guestalpha").count(), 0);
    await queue("doctor:synthetic", "session:afternoon");
    assert.equal(await page.locator(".queue-booked tbody button").count(), 1);
    assert.equal(
      await booked("Phonelater").getByRole("button").isDisabled(),
      true,
    );
    await queue("doctor:synthetic", "session:synthetic", laterDate);
    assert.equal(await page.locator(".queue-booked tbody button").count(), 1);
    assert.equal(
      await booked("Phonefuture").getByRole("button").isDisabled(),
      true,
    );
    pass(
      "Booked list isolates two professionals, morning/afternoon and future dated sessions; unresolved requests do not leak and early check-in is disabled",
    );
    stage = "row check-in, uncertain retry and FCFS";
    await queue();
    await booked("Phoneone").getByRole("button").click();
    await waiting("Phoneone").waitFor();
    loseArrival = true;
    await booked("Guestalpha").getByRole("button").click();
    await page.getByRole("alert").waitFor();
    const key = arrivalRequests.at(-1).idempotencyKey;
    assert.equal(await waiting("Guestalpha").count(), 0);
    await booked("Guestalpha").getByRole("button").click();
    await waiting("Guestalpha").waitFor();
    assert.equal(arrivalRequests.at(-1).idempotencyKey, key);
    assert.match(await waiting("Phoneone").innerText(), /#01/);
    assert.match(await waiting("Guestalpha").innerText(), /#02/);
    assert.equal(await booked("Guestalpha").count(), 0);
    pass(
      "Exact row checks in its patient; reversed booking order yields FCFS #01/#02, lost response shows no optimistic success and same-key retry allocates once",
    );
    stage = "absence, return and safe correction";
    await manage("Phoneone", "Mark absent");
    await page
      .locator(".queue-absent tbody tr")
      .filter({ hasText: "Phoneone" })
      .getByRole("button", { name: "Returnedâ€”join end", exact: true })
      .click();
    await waiting("Phoneone").waitFor();
    assert.match(
      await page.locator(".queue-waiting tbody tr").last().innerText(),
      /#01.*Phoneone/s,
    );
    await manage("Phoneone", "Call this patient instead");
    await page
      .getByLabel("Reason", { exact: true })
      .fill("Professional instructed fictional exception");
    await page
      .getByLabel("The professional instructed this call", { exact: true })
      .check();
    await page
      .getByRole("button", { name: "Call patient", exact: true })
      .click();
    await page.locator(".queue-active summary").click();
    await page
      .getByRole("button", { name: "Correct last change", exact: true })
      .click();
    await page
      .getByLabel("Reason", { exact: true })
      .fill("Correct fictional mistaken call");
    await page.getByRole("button", { name: "Undo call", exact: true }).click();
    await page.getByRole("button", { name: /Call next/ }).click();
    await page
      .getByRole("button", { name: "Start consultation", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Complete consultation", exact: true })
      .click();
    await page.getByRole("button", { name: "Completed", exact: true }).click();
    await page
      .locator(".queue-history tbody")
      .getByText("Guestalpha Patient Synthetic", { exact: true })
      .waitFor();
    await manage("Phoneone", "Mark as left");
    await page.getByRole("button", { name: "Left", exact: true }).click();
    await manage("Phoneone", "Correct last change", ".queue-history");
    await page
      .getByLabel("Reason", { exact: true })
      .fill("Correct fictional mistaken departure");
    await page
      .getByRole("button", { name: "Undo departure", exact: true })
      .click();
    pass(
      "Patient-bound absence/end return, instructed call/correction, consultation completion and Left/correction retain stable numbers and history",
    );
    stage = "walk-in, extra and professional slot isolation";
    await admit("Walkin");
    await admit("Extra", true);
    assert.equal(
      await fixture.db.collection("bookings").countDocuments({
        datedSessionId: stored.find((b) => b.patientId === patients.Phoneone.id)
          .datedSessionId,
        status: "confirmed",
        admissionKind: { $ne: "extra" },
      }),
      4,
    );
    assert.equal(
      await fixture.db
        .collection("bookings")
        .countDocuments({ admissionKind: "extra" }),
      1,
    );
    await page.getByRole("button", { name: /Call next/ }).click();
    await queue("doctor:second", "session:second");
    await booked("Phonetwo").getByRole("button").click();
    await waiting("Phonetwo").waitFor();
    await page.getByRole("button", { name: /Call next/ }).click();
    await page
      .locator(".queue-active")
      .getByText("Phonetwo Patient Synthetic", { exact: true })
      .waitFor();
    assert.equal(
      await fixture.db
        .collection("bookings")
        .countDocuments({ "queue.status": "called" }),
      2,
    );
    await page
      .getByRole("button", { name: "Start consultation", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Complete consultation", exact: true })
      .click();
    pass(
      "Real walk-in/extra actions retain ordinary limit4; two professionals have independent active slots and #01 sequences",
    );
    stage = "end and safe missed arrival correction";
    fixture.advance(60000);
    await fixture.reconcileQueue();
    await queue();
    assert.equal(await page.locator(".queue-booked tbody button").count(), 0);
    await page
      .getByRole("button", { name: "Start consultation", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Complete consultation", exact: true })
      .click();
    await page.getByRole("button", { name: "No-show", exact: true }).click();
    const missing = page
      .locator(".queue-history tbody tr")
      .filter({ hasText: "Phonemissing" });
    await missing.waitFor();
    assert.equal(await missing.locator("td").first().innerText(), "â€”");
    await manage("Phonemissing", "Correct missed arrival", ".queue-history");
    await page
      .getByLabel("Reason", { exact: true })
      .fill("Staff missed a fictional earlier arrival");
    await page
      .getByRole("button", { name: "Restore to waiting", exact: true })
      .click();
    assert.equal(
      await page
        .locator('.queue-check-in input[type="checkbox"]')
        .evaluate((el) => el.validity.valueMissing),
      true,
    );
    await page
      .getByLabel("I confirm this patient arrived before the session ended", {
        exact: true,
      })
      .check();
    await page
      .getByRole("button", { name: "Restore to waiting", exact: true })
      .click();
    await waiting("Phonemissing").waitFor();
    assert.match(
      await waiting("Phonemissing").innerText(),
      /#05.*Earlier arrival reported/s,
    );
    assert.equal(
      await fixture.db
        .collection("queue_changes")
        .countDocuments({ action: "no_show" }),
      2,
    );
    assert.equal(
      await fixture.db
        .collection("bookings")
        .countDocuments({ status: "confirmed" }),
      9,
    );
    await page.screenshot({
      path: resolve(evidence, "after-lifecycle.png"),
      fullPage: true,
    });
    pass(
      "End reconciles only genuine unarrived bookings across professionals, arrived consultation finishes, correction requires evidence and appends #05 without allowance release",
    );
    stage = "reopen persistence and responsive list";
    await desktop.close();
    desktop = null;
    await fixture.restart();
    await launchDesktop();
    await queue();
    await waiting("Phonemissing").waitFor();
    await queue("doctor:synthetic", "session:afternoon");
    for (const width of [1440, 1024, 768, 360]) {
      await desktop
        .browserWindow(page)
        .then((w) =>
          w.evaluate((win, width) => win.setSize(width, 1000), width),
        );
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
        false,
      );
      await page.screenshot({
        path: resolve(evidence, `booked-${width}.png`),
        fullPage: true,
      });
    }
    assert.deepEqual(errors, []);
    pass(
      "Exact packaged app and TEST API reopen preserve outcomes; booked list fits supported widths without observed renderer/security errors",
    );
  }
  await writeFile(
    resolve(evidence, interactive ? "manual-session.json" : "results.json"),
    JSON.stringify(
      {
        checks,
        interactive,
        errors,
        date,
        laterDate,
        package: executable,
        actualWebsiteForm: !interactive && !uiEvidence,
        uiEvidence,
        operator: uiEvidence
          ? "Agent via Playwright driving actual packaged UI; not human manual acceptance"
          : "existing acceptance harness",
        actualPackagedPhone: !interactive,
        hosted: false,
        syntheticOnly: true,
      },
      null,
      2,
    ),
  );
} catch (error) {
  await page
    ?.screenshot({
      path: resolve(evidence, "failure-staff.png"),
      fullPage: true,
    })
    .catch(() => {});
  await web
    ?.screenshot({
      path: resolve(evidence, "failure-website.png"),
      fullPage: true,
    })
    .catch(() => {});
  console.error(`FAIL at ${stage}: ${error.message}`);
  process.exitCode = 1;
} finally {
  await desktop?.close().catch(() => {});
  await browser?.close().catch(() => {});
  for (const server of [proxy, publicServer])
    if (server?.listening) {
      server.closeIdleConnections?.();
      await new Promise((r) => server.close(r));
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
