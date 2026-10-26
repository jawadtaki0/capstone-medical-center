import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { resolve, relative, isAbsolute, sep } from "node:path";
import { mkdir, access, open, unlink } from "node:fs/promises";
import { _electron as electron } from "playwright";
import { readLauncherConfig } from "../../staff-api/scripts/launcher/configuration.js";
import { verifySyntheticManager } from "./operational-review-controls.js";

// Owned loopback proxy -> owned TEST API -> guarded real TEST MongoDB.
// Never connects to development accounts, providers or the public application.
const args = process.argv.slice(2),
  packageIndex = args.indexOf("--package"),
  interactive = args.includes("--interactive");
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
const roleIndex = args.indexOf("--role");
let chosenRole = roleIndex < 0 ? "Admin" : args[roleIndex + 1];
const roles = ["Admin", "Clinic Admin", "Lab Admin", "Receptionist"];
assert.ok(roles.includes(chosenRole));
let fixture,
  reviewLock,
  proxy,
  client,
  page,
  tick,
  lastTick,
  stage = "initialization",
  unavailable = false,
  slowRead = false;
const errors = [],
  external = [],
  people = new Map();
let checkpoints = 0;
const pass = (label) => console.log(`PASS ${++checkpoints}: ${label}`);
const ok = (response) => {
  assert.equal(response.status, 200, "Owned TEST action failed");
  return response.body;
};
let adminToken;
const post = (action, body) =>
  fixture.request(`/operations/${action}`, {
    method: "POST",
    token: adminToken,
    body,
  });
const save = (type, record, expectedRevision = 0) =>
  post("save", { type, record, expectedRevision }).then(ok);
async function loginApi(person) {
  let result = ok(
    await fixture.request("/auth/login", {
      method: "POST",
      body: { username: person.username, password: person.password },
    }),
  );
  if (!result.token)
    result = ok(
      await fixture.request("/mfa/complete", {
        method: "POST",
        body: {
          challenge: result.challenge,
          code: await fixture.totp(person.secret),
        },
      }),
    );
  return result.token;
}
async function launch(role) {
  await client?.close();
  client = undefined;
  if (!interactive) fixture.advance(31000);
  const person = people.get(role);
  client = await electron.launch({
    ...(executable
      ? { executablePath: executable, args: ["--demo-loopback"] }
      : { args: [resolve("apps/staff"), "--demo-loopback"] }),
    env: { ...process.env, STAFF_API_URL: "http://127.0.0.1:4101" },
    timeout: 30000,
  });
  page = await client.firstWindow();
  page.setDefaultTimeout(12000);
  page.on("pageerror", () => errors.push("renderer exception"));
  page.on("console", (message) => {
    if (
      message.type() === "error" ||
      /Electron Security Warning/i.test(message.text())
    )
      errors.push("runtime/security error");
  });
  page.on("request", (request) => {
    if (/^https?:/i.test(request.url()))
      external.push("renderer external request");
  });
  await page.getByRole("heading", { name: "Sign in to Cedar Staff" }).waitFor();
  await page.getByLabel("Username", { exact: true }).fill(person.username);
  await page
    .getByLabel("Password or passphrase", { exact: true })
    .fill(person.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  if (person.secret) {
    await page.getByLabel(/Authenticator code/i).fill(await freshCode(person));
    await page
      .getByRole("button", { name: "Verify and continue", exact: true })
      .click();
  }
  await page
    .getByRole("heading", { name: "Staff workspace", exact: true })
    .waitFor();
}
async function freshCode(person) {
  // Real replay prevention remains enabled. Wait for a genuinely unused step;
  // never change stored factors or advance review time to manufacture proof.
  const deadline = Date.now() + 35000;
  while (Date.now() < deadline) {
    const record = await fixture.db
      .collection("accounts")
      .findOne({ _id: person.id });
    const step = Math.floor(fixture.clock().getTime() / 30000);
    if (record?.mfa?.enabled && step > record.mfa.lastAcceptedStep)
      return fixture.totp(person.secret);
    await delay(250);
  }
  throw new Error(
    "No fresh synthetic MFA step available; retry after the next 30-second interval.",
  );
}
async function verifyReviewAction(role) {
  await verifySyntheticManager({
    page,
    person: people.get(role),
    nextCode: () => freshCode(people.get(role)),
  });
}
async function interactiveReview() {
  const terminal = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  console.log(
    "TEST ONLY. Commands: verify (complete the open management password/MFA popup), reopen, role <exact role>, help, quit. No credentials are printed. Reopen/role do not reset review edits. Closing the window keeps this session running; quit ends it and clears expendable TEST fixtures. Never run TEST suites concurrently.",
  );
  let commandBusy = false;
  await new Promise((resolve) => {
    terminal.on("line", async (line) => {
      if (commandBusy) {
        console.log("Wait for the current review command.");
        return;
      }
      commandBusy = true;
      try {
        const command = line.trim();
        if (command === "quit") {
          terminal.close();
          return;
        }
        if (command === "verify") {
          if (
            !page ||
            page.isClosed() ||
            !(await page
              .getByRole("heading", {
                name: "Verify this management action",
                exact: true,
              })
              .count())
          )
            throw new Error(
              "Open a protected action's verification popup first.",
            );
          console.log(
            "Completing the real TEST password/MFA checks; an already-used TOTP may require up to 30 seconds.",
          );
          await verifyReviewAction(chosenRole);
          console.log(
            "Synthetic verification completed. Check the app's action result.",
          );
        } else if (command === "reopen" || command.startsWith("role ")) {
          const role = command === "reopen" ? chosenRole : command.slice(5);
          if (!roles.includes(role))
            throw new Error("Use one of the four exact staff role names.");
          if (
            page &&
            !page.isClosed() &&
            (await page.getByRole("dialog").count())
          )
            throw new Error(
              "Save or cancel the open dialog before changing the review window. Unsaved drafts were not discarded.",
            );
          await launch(role);
          chosenRole = role;
          console.log(
            `Opened ${role}; existing TEST edits and assignments preserved.`,
          );
        } else
          console.log(
            `Current role: ${chosenRole}. Commands: verify | reopen | role Admin | role Clinic Admin | role Lab Admin | role Receptionist | quit`,
          );
      } catch {
        console.log(
          "Review command could not complete. Check the app's safe error, keep the current draft, and retry. No credentials or responses printed.",
        );
      } finally {
        commandBusy = false;
      }
    });
    terminal.once("close", () => {
      process.stdin.pause();
      resolve();
    });
  });
}
async function noOverflow() {
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
    "Horizontal overflow",
  );
}
try {
  await mkdir(".local/professional-schedule-review", { recursive: true });
  reviewLock = await open(
    ".local/professional-schedule-review/review.lock",
    "wx",
  );
  const selectedRuntime = await readLauncherConfig();
  process.env.CAPSTONE_STAFF_RUNTIME_DIR = selectedRuntime.runtimeDirectory;
  // Reserve the owned proxy BEFORE any TEST cleanup; never displace a listener.
  proxy = createServer((_request, response) => {
    response.writeHead(503);
    response.end("TEST review is starting.");
  });
  proxy.listen(4101, "127.0.0.1");
  await once(proxy, "listening");
  const { createSecurityFixture } =
    await import("../../staff-api/test/helpers/security-fixture.js");
  fixture = await createSecurityFixture();
  await fixture.reset();
  for (const role of roles)
    people.set(
      role,
      await fixture.account({
        roles: [role],
        mfa: !role.includes("Receptionist"),
        username: `review.${role.toLowerCase().replaceAll(" ", ".")}`,
      }),
    );
  adminToken = await loginApi(people.get("Admin"));
  for (const scope of [
    { id: "review-clinic", name: "Synthetic Clinic One", kind: "clinic" },
    { id: "review-other", name: "Synthetic Clinic Two", kind: "clinic" },
    { id: "review-audio", name: "Audiometry", kind: "service" },
  ])
    await save("scopes", { ...scope, active: true });
  for (const p of [
    {
      id: "doctor:review",
      kind: "doctor",
      name: "Dr. Synthetic Review",
      specialty: "Dentistry",
    },
    {
      id: "specialist:review",
      kind: "specialist",
      name: "Synthetic Therapist",
      specialty: "Therapist",
    },
  ])
    await save("professionals", {
      ...p,
      active: true,
      gender: "neutral",
      scopeIds: ["review-clinic"],
    });
  const base = {
    weekday: 1,
    startTime: "09:00",
    endTime: "11:00",
    capacity: 5,
    status: "active",
    appointmentRequired: false,
  };
  await save("sessions", {
    ...base,
    id: "review-session",
    scopeId: "review-clinic",
    professionalId: "doctor:review",
  });
  await save("sessions", {
    ...base,
    id: "review-specialist",
    scopeId: "review-clinic",
    professionalId: "specialist:review",
  });
  await save("sessions", {
    ...base,
    id: "review-audio-hours",
    scopeId: "review-audio",
    professionalId: null,
    capacity: null,
    endTime: "14:30",
  });
  for (let day = 0; day < 7; day++)
    await save("hours", {
      id: String(day),
      closed: day === 0,
      ...(day
        ? { startTime: "08:00", endTime: day === 6 ? "13:00" : "17:00" }
        : {}),
    });
  for (const role of roles.filter((r) => r !== "Admin"))
    ok(
      await post("grants", {
        accountId: people.get(role).id,
        scopeIds:
          role === "Receptionist"
            ? ["review-clinic", "review-audio"]
            : [role.startsWith("Clinic") ? "review-clinic" : "review-audio"],
        expectedRevision: 0,
        confirmed: true,
      }),
    );
  const state = ok(await fixture.request("/operations", { token: adminToken }));
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Beirut",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(fixture.clock())
      .map(({ type, value }) => [type, value]),
  );
  ok(
    await post("publish", {
      scopeIds: state.scopes.map((s) => s.id),
      expectedRevision: state.revision,
      expectedHead: state.head,
      effectiveFrom: `${parts.year}-${parts.month}-${parts.day}`,
      confirmed: true,
    }),
  );
  proxy.removeAllListeners("request");
  proxy.on("request", async (request, response) => {
    try {
      if (unavailable) {
        response.writeHead(503, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            error: {
              code: "authority_unavailable",
              message: "Owned TEST authority is temporarily unavailable.",
            },
          }),
        );
        return;
      }
      if (slowRead && request.url === "/operations") await delay(600);
      let text = "";
      for await (const chunk of request) {
        text += chunk;
        if (text.length > 16384) throw new Error("TEST proxy body refused");
      }
      const result = await fixture.request(request.url, {
        method: request.method,
        ...(text ? { body: JSON.parse(text) } : {}),
        token: request.headers.authorization?.replace(/^Bearer /, ""),
      });
      response.writeHead(result.status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(result.body));
    } catch {
      if (!response.writableEnded) {
        response.writeHead(503, { "Content-Type": "application/json" });
        response.end(
          '{"error":{"code":"authority_unavailable","message":"Owned TEST proxy refused the action."}}',
        );
      }
    }
  });
  lastTick = Date.now();
  tick = setInterval(() => {
    const at = Date.now();
    fixture.advance(at - lastTick);
    lastTick = at;
  }, 1000);
  if (interactive) {
    stage = `interactive ${chosenRole}`;
    await launch(chosenRole);
    console.log(
      `Opened isolated synthetic ${chosenRole}. Assignments: Clinic Admin -> Synthetic Clinic One; Lab Admin -> Audiometry; Receptionist -> both, read-only; Admin all. Keep CMD open: closing the window does not reset this review. Use quit to stop its owned services and clear expendable TEST data. Do not run TEST suites concurrently.`,
    );
    await interactiveReview();
  } else {
    stage = "Admin UI";
    await launch("Admin");
    await page
      .getByRole("button", { name: "Professionals", exact: true })
      .click();
    await page
      .getByRole("heading", { name: "Dr. Synthetic Review", exact: true })
      .waitFor();
    pass(
      "Admin sees doctors and non-doctor specialists from real TEST persistence",
    );
    slowRead = true;
    await page
      .getByRole("button", { name: "Reload drafts", exact: true })
      .click();
    const refreshing = page.getByRole("button", {
      name: "Reloading drafts…",
      exact: true,
    });
    await refreshing.waitFor();
    assert.equal(await refreshing.isDisabled(), true);
    assert.equal(await refreshing.getAttribute("aria-busy"), "true");
    assert.equal(await refreshing.locator(".operational-loading").count(), 1);
    await page.getByText("Drafts refreshed", { exact: true }).waitFor();
    slowRead = false;
    assert.equal(
      await page
        .getByLabel("Search professionals by name or specialty")
        .isVisible(),
      true,
    );
    assert.equal(
      await page.locator(".operational-search svg[aria-hidden=true]").count(),
      1,
    );
    pass(
      "Reload drafts busy indicator and success announcement; labelled search retains decorative icon",
    );
    const search = page.getByLabel("Search professionals by name or specialty");
    const searchHasSpace = () =>
      page.evaluate(() => {
        const input = document.querySelector(".operational-search input");
        const icon = document.querySelector(".operational-search svg");
        const textStart =
          input.getBoundingClientRect().left +
          parseFloat(getComputedStyle(input).paddingLeft);
        return textStart >= icon.getBoundingClientRect().right + 6;
      });
    assert.equal(
      await searchHasSpace(),
      true,
      "Search text must clear the icon",
    );
    await search.fill("therapist");
    await page
      .getByRole("heading", { name: "Synthetic Therapist", exact: true })
      .waitFor();
    assert.equal(
      await page
        .getByRole("heading", { name: "Dr. Synthetic Review", exact: true })
        .count(),
      0,
    );
    await page.waitForFunction(() => {
      const icon = document.querySelector(".operational-search svg");
      const matrix = new DOMMatrix(getComputedStyle(icon).transform);
      return matrix.e < -3 && Math.abs(matrix.b + 1) < 0.01;
    });
    assert.equal(await searchHasSpace(), true);
    await search.fill("");
    await page
      .getByRole("heading", { name: "Dr. Synthetic Review", exact: true })
      .waitFor();
    await page.waitForFunction(
      () =>
        Math.abs(
          new DOMMatrix(
            getComputedStyle(document.querySelector(".operational-search svg"))
              .transform,
          ).e,
        ) < 0.01,
    );
    await page.setViewportSize({ width: 360, height: 760 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await search.fill("therapist");
    assert.equal(
      await page
        .locator(".operational-search svg")
        .evaluate((el) => getComputedStyle(el).transitionDuration),
      "0s",
    );
    assert.equal(await searchHasSpace(), true);
    await noOverflow();
    await page.screenshot({
      path: `.local/professional-schedule-review/${executable ? "packaged" : "development"}-search-mobile.png`,
      fullPage: true,
    });
    await search.fill("");
    await page.setViewportSize({ width: 1050, height: 800 });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    pass(
      "approved search inset, roll on typing/reverse on clear, real filtering, reduced motion and narrow layout",
    );
    await mkdir(".local/professional-schedule-review", { recursive: true });
    await page.screenshot({
      path: `.local/professional-schedule-review/${executable ? "packaged" : "development"}-professionals-desktop.png`,
      fullPage: true,
    });
    await page
      .getByRole("button", { name: "Add professional", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    assert.equal(
      await page.evaluate(() =>
        document
          .querySelector('[role="dialog"]')
          .contains(document.activeElement),
      ),
      true,
    );
    await page.keyboard.press("Shift+Tab");
    assert.equal(
      await page.evaluate(() =>
        document
          .querySelector('[role="dialog"]')
          .contains(document.activeElement),
      ),
      true,
    );
    await page
      .getByLabel("Professional name and actual title")
      .fill("Synthetic long professional review name for wrapping");
    await page
      .getByLabel("Specialty", { exact: true })
      .fill(
        "Synthetic long specialty used only to verify complete wrapping and readable labels",
      );
    await page.getByLabel("Synthetic Clinic One", { exact: true }).check();
    await page.getByRole("button", { name: "Save draft", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    await page
      .getByRole("heading", {
        name: "Synthetic long professional review name for wrapping",
      })
      .waitFor();
    pass("actual profile draft save, scope selection and long text wrapping");
    await page
      .getByRole("button", { name: "Add professional", exact: true })
      .click();
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    assert.equal(
      await page
        .getByRole("button", { name: "Add professional", exact: true })
        .evaluate((el) => el === document.activeElement),
      true,
    );
    pass("focus trap, Escape cancellation and focus restoration");
    await page.getByRole("button", { name: "Schedules", exact: true }).click();
    await page
      .getByLabel("Recurring weekday", { exact: true })
      .selectOption("1");
    await page
      .getByRole("heading", { name: "Dr. Synthetic Review", exact: true })
      .waitFor();
    await page.screenshot({
      path: `.local/professional-schedule-review/${executable ? "packaged" : "development"}-schedule-desktop.png`,
      fullPage: true,
    });
    await page
      .getByRole("button", {
        name: "Add recurring session / service hours",
        exact: true,
      })
      .click();
    assert.equal(
      await page.getByLabel("Clinic/service", { exact: true }).inputValue(),
      "",
    );
    assert.equal(
      await page
        .getByLabel("Clinic/service", { exact: true })
        .locator('option[value=""]')
        .isDisabled(),
      true,
    );
    await page.getByLabel("Session start", { exact: true }).fill("13:00");
    await page.getByLabel("Session end", { exact: true }).fill("14:00");
    await page.getByRole("button", { name: "Save draft", exact: true }).click();
    assert.equal(await dialog.isVisible(), true);
    assert.equal(
      await page
        .getByLabel("Clinic/service", { exact: true })
        .evaluate((el) => el.validity.valueMissing),
      true,
    );
    pass(
      "blank scope is a disabled placeholder and cannot submit a session draft",
    );
    await page
      .getByLabel("Clinic/service", { exact: true })
      .selectOption("review-clinic");
    await page
      .getByLabel("Professional", { exact: true })
      .selectOption("doctor:review");
    await page.getByLabel("Session start", { exact: true }).fill("13:00");
    await page.getByLabel("Session end", { exact: true }).fill("14:00");
    await page.getByRole("button", { name: "Save draft", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    await page
      .getByText("Capacity: Unconfirmed — cannot publish", { exact: false })
      .waitFor();
    await page
      .getByRole("button", { name: "Review publication", exact: true })
      .click();
    await page.getByLabel("Synthetic Clinic One", { exact: true }).check();
    await page.getByLabel(/I reviewed these drafts/).check();
    await page
      .getByRole("button", { name: "Publish selected drafts", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("alert")
      .filter({ hasText: "capacity" })
      .waitFor();
    await page.keyboard.press("Escape");
    pass(
      "blank capacity persists as draft and publication refuses it in real TEST API",
    );
    await page
      .getByRole("button", {
        name: "Add dated leave / changed hours",
        exact: true,
      })
      .click();
    await page.getByRole("dialog").waitFor();
    await page
      .getByLabel("Assigned clinic/service", { exact: true })
      .selectOption("review-clinic");
    await page.keyboard.press("Escape");
    await page
      .getByRole("button", { name: "Clinics & services", exact: true })
      .click();
    await page
      .getByRole("heading", {
        name: "Explicit staff scope assignments",
        exact: true,
      })
      .waitFor();
    pass(
      "Admin-only registry, explicit assignments and dated-exception editor render",
    );
    await page.setViewportSize({ width: 360, height: 760 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await noOverflow();
    await mkdir(".local/professional-schedule-review", { recursive: true });
    await page.screenshot({
      path: `.local/professional-schedule-review/${executable ? "packaged" : "development"}-registry-mobile.png`,
      fullPage: true,
    });
    pass(
      "360px layout and reduced-motion rendering without horizontal overflow",
    );
    stage = "verification cancellation";
    fixture.advance(6 * 60000);
    await page
      .getByRole("button", { name: "Add clinic/service", exact: true })
      .click();
    await page
      .getByLabel("Clinic/service name", { exact: true })
      .fill("Synthetic verification cancellation");
    await page.getByRole("button", { name: "Save draft", exact: true }).click();
    await page
      .getByRole("heading", {
        name: "Verify this management action",
        exact: true,
      })
      .waitFor();
    await page
      .getByRole("button", { name: "Cancel action", exact: true })
      .click();
    await page
      .getByRole("heading", {
        name: "Verify this management action",
        exact: true,
      })
      .waitFor({ state: "detached" });
    await page.waitForFunction(
      () =>
        !document.querySelector(
          '.operational-dialog button[type="submit"]:disabled',
        ),
    );
    assert.equal(
      await page
        .getByLabel("Clinic/service name", { exact: true })
        .inputValue(),
      "Synthetic verification cancellation",
    );
    assert.equal(
      await page.evaluate(() =>
        document
          .querySelector('[role="dialog"]')
          .contains(document.activeElement),
      ),
      true,
      "Cancelled verification must return focus inside the still-open editor",
    );
    await page.keyboard.press("Escape");
    pass(
      "cancelled sensitive verification preserves draft and modal keyboard focus",
    );
    await page
      .getByRole("button", { name: "Add clinic/service", exact: true })
      .click();
    await page
      .getByLabel("Clinic/service name", { exact: true })
      .fill("Synthetic protected save retained");
    await page.getByRole("button", { name: "Save draft", exact: true }).click();
    await verifyReviewAction("Admin");
    await dialog.waitFor({ state: "detached" });
    await page
      .getByRole("heading", {
        name: "Synthetic protected save retained",
        exact: true,
      })
      .waitFor();
    const retained = ok(
      await fixture.request("/operations", { token: adminToken }),
    );
    assert.ok(
      retained.scopes.some(
        (s) => s.name === "Synthetic protected save retained",
      ),
    );
    await launch("Lab Admin");
    await launch("Admin");
    await page
      .getByRole("button", { name: "Clinics & services", exact: true })
      .click();
    await page
      .getByRole("heading", {
        name: "Synthetic protected save retained",
        exact: true,
      })
      .waitFor();
    pass(
      "real password/MFA re-verification completes protected save; role changes/reopen preserve persisted review edits",
    );
    await page.getByRole("button", { name: "Schedules", exact: true }).click();
    await page
      .getByLabel("View a specific date (including dated exceptions)", {
        exact: true,
      })
      .check();
    await page
      .getByText(/Showing the effective sessions for this date:/)
      .waitFor();
    assert.equal(
      await page
        .getByRole("button", { name: "Edit session", exact: true })
        .count(),
      0,
    );
    await page
      .getByLabel("View a specific date (including dated exceptions)", {
        exact: true,
      })
      .uncheck();
    await page.getByText(/Showing recurring weekly hours/).waitFor();
    pass(
      "dated effective view and recurring weekly editing explain separate one-date exception path",
    );
    stage = "outage";
    unavailable = true;
    await page
      .getByRole("button", { name: "Reload drafts", exact: true })
      .click();
    await page
      .getByRole("heading", {
        name: "Local staff server unavailable",
        exact: true,
      })
      .waitFor();
    unavailable = false;
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    await page
      .getByRole("heading", { name: "Sign in to Cedar Staff", exact: true })
      .waitFor();
    pass("owned TEST proxy outage shows safe error; no shared service stopped");
    for (const role of roles.slice(1)) {
      stage = `${role} UI`;
      await launch(role);
      {
        await page
          .getByRole("button", { name: "Schedules", exact: true })
          .click();
        await page
          .getByLabel("Recurring weekday", { exact: true })
          .selectOption("1");
        if (role.startsWith("Lab"))
          await page
            .getByText("Audiometry · 09:00–14:30", { exact: false })
            .waitFor();
        else
          await page
            .getByRole("heading", { name: "Dr. Synthetic Review", exact: true })
            .first()
            .waitFor();
        assert.equal(
          await page
            .getByRole("button", { name: "Review publication", exact: true })
            .count(),
          role.includes("Receptionist") ? 0 : 1,
        );
        assert.equal(
          await page
            .getByRole("button", { name: "Clinics & services", exact: true })
            .count(),
          0,
        );
        await page.setViewportSize({ width: 360, height: 760 });
        await noOverflow();
      }
      pass(
        `${role} assigned/read-only/no-operational-authority boundary in actual Electron`,
      );
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    pass(
      "no renderer exceptions/security errors or renderer external requests",
    );
  }
} catch (error) {
  console.error(
    `FAIL at ${stage}: ${error.name} / ${String(error.message)
      .split("\n")[0]
      .replace(
        /review\.[A-Za-z.]+/g,
        "synthetic",
      )}. No private inputs or response contents printed.`,
  );
  process.exitCode = 1;
} finally {
  clearInterval(tick);
  await client?.close().catch(() => {});
  if (proxy?.listening) {
    proxy.closeAllConnections();
    await new Promise((resolve) => proxy.close(resolve));
  }
  try {
    if (fixture) {
      try {
        await fixture.reset();
      } finally {
        await fixture.close();
      }
    }
  } catch {
    console.error(
      "Owned TEST cleanup could not complete. No development cleanup was attempted.",
    );
    process.exitCode = 1;
  } finally {
    if (reviewLock) {
      await reviewLock.close();
      await unlink(".local/professional-schedule-review/review.lock");
    }
  }
}
