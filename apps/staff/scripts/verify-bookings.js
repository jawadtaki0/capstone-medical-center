import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { resolve, relative, isAbsolute, sep } from "node:path";
import { mkdir, open, unlink, access, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { _electron as electron } from "playwright";
import { readLauncherConfig } from "../../staff-api/scripts/launcher/configuration.js";

// Owned loopback proxy + guarded synthetic TEST database only. Never normal APIs,
// SMTP, bootstrap, launcher selection or a developer's real credentials.
const args = process.argv.slice(2),
  interactive = args.includes("--interactive");
const pi = args.indexOf("--package"),
  executable = pi < 0 ? undefined : resolve(args[pi + 1]);
const ri = args.indexOf("--role"),
  role = ri < 0 ? "Receptionist" : args[ri + 1];
assert.ok(
  ["Admin", "Clinic Admin", "Lab Admin", "Receptionist"].includes(role),
);
if (executable) {
  const rel = relative(resolve("apps/staff/release"), executable);
  assert.ok(
    rel &&
      !rel.startsWith(`..${sep}`) &&
      !isAbsolute(rel) &&
      rel.endsWith(".exe"),
  );
  await access(executable);
}
const lockPath = resolve(".local/professional-schedule-review/review.lock"),
  evidence = resolve(".local/staff-booking-review");
let lock,
  fixture,
  proxy,
  client,
  page,
  stage = "exclusive review lock",
  checks = 0,
  unavailable = false,
  uncertain = false,
  confirmations = 0;
const errors = [],
  external = [];
const pass = (label) => {
  checks++;
  console.log(`PASS ${checks}: ${label}`);
};
const good = (r) => {
  assert.equal(r.status, 200, r.body?.error?.code);
  return r.body;
};
try {
  await mkdir(resolve(".local/professional-schedule-review"), {
    recursive: true,
  });
  await mkdir(evidence, { recursive: true });
  lock = await open(lockPath, "wx");
  await lock.writeFile(
    JSON.stringify({
      pid: process.pid,
      kind: "staff-booking-synthetic-review",
    }),
  );
  stage = "owned TEST port";
  proxy = createServer(async (req, res) => {
    try {
      const parts = [];
      let bytes = 0;
      for await (const part of req) {
        bytes += part.length;
        if (bytes > 16384) throw Error("Oversize TEST request");
        parts.push(part);
      }
      if (!fixture || (unavailable && req.url.startsWith("/bookings/"))) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              code: "authority_unavailable",
              message: "Owned TEST server unavailable. Retry when ready.",
            },
          }),
        );
        return;
      }
      const result = await fixture.request(req.url, {
        method: req.method,
        token: req.headers.authorization?.replace(/^Bearer /, ""),
        ...(bytes ? { body: JSON.parse(Buffer.concat(parts).toString()) } : {}),
      });
      if (req.url === "/bookings/confirm") {
        confirmations++;
        if (uncertain) {
          uncertain = false;
          res.destroy();
          return;
        }
      }
      res.writeHead(result.status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(result.body));
    } catch {
      if (!res.headersSent)
        res.writeHead(503, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            code: "authority_unavailable",
            message: "Owned TEST request failed safely.",
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
  const { beirutClock } = await import("../../staff-api/src/booking-model.js");
  fixture = await createSecurityFixture();
  await fixture.reset();
  const authority = await seedPublicationAuthority(fixture);
  good(await authority.publish(null));
  const actor = await fixture.account({
    roles: [role],
    mfa: role !== "Receptionist",
    username: "synthetic.booking.review",
  });
  await fixture.db.collection("operational_grants").insertOne({
    _id: actor.id,
    id: actor.id,
    scopeIds: ["clinic:synthetic"],
    revision: 1,
  });
  const patients = [];
  for (const lastName of ["Bookingone", "Bookingtwo"]) {
    const record = {
      firstName: "Synthetic",
      fatherName: "Patientfather",
      lastName,
      motherFirstName: "Patientmother",
      dateOfBirth: "2000-02-29",
      phone: "+96171123456",
      gender: "female",
    };
    const review = good(
      await fixture.request("/patients/check", {
        method: "POST",
        token: authority.admin.token,
        body: { record },
      }),
    );
    patients.push(
      good(
        await fixture.request("/patients/create", {
          method: "POST",
          token: authority.admin.token,
          body: {
            record,
            reviewDigest: review.reviewDigest,
            duplicateOverride: {
              acknowledged: true,
              reason: "Synthetic distinct test patient",
            },
          },
        }),
      ).patient,
    );
  }
  const next = new Date(`${beirutClock(fixture.clock()).date}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + ((8 - next.getUTCDay()) % 7 || 7));
  const date = next.toISOString().slice(0, 10);
  stage = "desktop sign-in";
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
      errors.push("renderer/security error");
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
  await page.getByRole("button", { name: "Patients", exact: true }).waitFor();
  if (role !== "Lab Admin") {
    await page.getByRole("button", { name: "Bookings", exact: true }).click();
    await page
      .getByRole("heading", { name: "Bookings", exact: true })
      .waitFor();
  } else
    assert.equal(
      await page.getByRole("button", { name: "Bookings", exact: true }).count(),
      0,
    );
  pass(
    `Real ${role} sign-in and role-relevant booking navigation; synthetic clinic assignment only`,
  );
  if (interactive) {
    console.log(
      `SYNTHETIC TEST ONLY — ${role}, assigned Synthetic Review Clinic. Two existing Synthetic patients. Session date ${date}; professional Dr. Synthetic Review, 09:00–11:00, limit 4. No password entry needed. Press Enter in this terminal to close owned app/services and clear TEST fixtures.`,
    );
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      await once(rl, "line");
    } finally {
      rl.close();
    }
  } else if (role === "Clinic Admin") {
    await page
      .getByLabel("Session date (Asia/Beirut)", { exact: true })
      .fill(date);
    await page
      .getByRole("button", { name: "Load sessions", exact: true })
      .click();
    await page
      .getByLabel("Professional", { exact: true })
      .selectOption("doctor:synthetic");
    assert.equal(await page.getByRole("radio").isDisabled(), true);
    assert.equal(
      await page
        .getByRole("button", { name: "Review booking", exact: true })
        .isDisabled(),
      true,
    );
    pass(
      "Assigned Clinic Admin can view sessions but cannot confirm through that role",
    );
  } else if (role !== "Lab Admin") {
    stage = "patient and session selection";
    await page.getByLabel("First name", { exact: true }).fill("Synthetic");
    await page
      .getByRole("button", { name: "Search patients", exact: true })
      .click();
    await page
      .getByRole("button", {
        name: `Select ${patients[0].patientNumber}`,
        exact: true,
      })
      .click();
    await page
      .getByLabel("Session date (Asia/Beirut)", { exact: true })
      .fill(date);
    await page
      .getByRole("button", { name: "Load sessions", exact: true })
      .click();
    await page
      .getByLabel("Professional", { exact: true })
      .selectOption("doctor:synthetic");
    await page.getByRole("radio").check();
    await page
      .getByRole("button", { name: "Review booking", exact: true })
      .click();
    let dialog = page.getByRole("dialog");
    await dialog
      .getByRole("heading", { name: "Review and confirm booking", exact: true })
      .waitFor();
    await dialog.getByText("4 remaining of 4", { exact: true }).waitFor();
    assert.ok(
      await dialog.evaluate((el) => el.contains(document.activeElement)),
    );
    await page.keyboard.press("Shift+Tab");
    assert.ok(
      await dialog.evaluate((el) => el.contains(document.activeElement)),
    );
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    assert.equal(
      await page
        .getByRole("button", { name: "Review booking", exact: true })
        .evaluate((el) => el === document.activeElement),
      true,
    );
    pass("Full-window review, keyboard trap, Escape and focus restoration");
    await page
      .getByRole("button", { name: "Review booking", exact: true })
      .click();
    dialog = page.getByRole("dialog");
    uncertain = true;
    await dialog
      .getByRole("button", { name: "Confirm booking", exact: true })
      .click();
    await dialog.getByRole("alert").waitFor();
    await dialog
      .getByRole("button", { name: "Confirm booking", exact: true })
      .click();
    await page
      .getByRole("heading", { name: "Booking confirmed", exact: true })
      .waitFor();
    assert.equal(await fixture.db.collection("bookings").countDocuments(), 1);
    assert.equal(confirmations, 2);
    pass(
      "Committed but lost response retries same key, displaying one immutable booking number",
    );
    await page
      .getByRole("button", { name: "Reload bookings", exact: true })
      .click();
    const b = await fixture.db.collection("bookings").findOne({});
    await page
      .getByRole("button", {
        name: `Cancel booking ${b.bookingNumber}`,
        exact: true,
      })
      .click();
    dialog = page.getByRole("dialog");
    await dialog
      .getByLabel("Cancellation reason")
      .fill("Synthetic patient requested cancellation");
    await dialog
      .getByLabel("Patient-facing cancellation reason")
      .selectOption("other");
    await dialog
      .getByRole("button", { name: "Confirm cancellation", exact: true })
      .click();
    await dialog.waitFor({ state: "detached" });
    await page
      .getByRole("heading", {
        name: `${b.bookingNumber} · Cancelled`,
        exact: true,
      })
      .waitFor();
    assert.equal(
      await fixture.db
        .collection("booking_changes")
        .countDocuments({ action: "cancelled" }),
      1,
    );
    pass("Cancellation persists and dated list retains history");
    await page
      .getByRole("button", { name: "Load sessions", exact: true })
      .click();
    await page
      .getByLabel("Professional", { exact: true })
      .selectOption("doctor:synthetic");
    await page.getByRole("radio").check();
    await page
      .getByRole("button", { name: "Review booking", exact: true })
      .click();
    dialog = page.getByRole("dialog");
    await client
      .browserWindow(page)
      .then((w) => w.evaluate((win) => win.setSize(390, 800)));
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    assert.equal(
      await dialog.evaluate((el) => el.scrollWidth > el.clientWidth),
      false,
    );
    await page.screenshot({
      path: resolve(
        evidence,
        executable ? "packaged-narrow.png" : "development-narrow.png",
      ),
    });
    pass("Narrow native window wraps review without horizontal overflow");
    await page.keyboard.press("Escape");
    unavailable = true;
    await page
      .getByRole("button", { name: "Load sessions", exact: true })
      .click();
    await page.getByRole("alert").filter({ hasText: "unavailable" }).waitFor();
    unavailable = false;
    await page
      .getByRole("button", { name: "Load sessions", exact: true })
      .click();
    await page.getByLabel("Professional", { exact: true }).waitFor();
    pass("Owned API outage fails safely and retry restores availability");
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    pass("No observed renderer/security errors or external renderer requests");
  }
  await writeFile(
    resolve(
      evidence,
      executable ? "packaged-results.json" : "development-results.json",
    ),
    JSON.stringify(
      { checks, interactive, errors, external, syntheticOnly: true },
      null,
      2,
    ),
  );
} catch (error) {
  if (page) {
    await writeFile(
      resolve(evidence, "failure-body.txt"),
      await page
        .locator("body")
        .innerText()
        .catch(() => "TEST renderer unavailable"),
    );
    await page
      .screenshot({ path: resolve(evidence, "failure.png") })
      .catch(() => {});
  }
  console.error(`FAIL at ${stage}: ${error.message}`);
  process.exitCode = 1;
} finally {
  await client?.close().catch(() => {});
  if (proxy?.listening) await new Promise((r) => proxy.close(r));
  if (fixture) {
    await fixture.reset();
    await fixture.close();
  }
  if (lock) {
    await lock.close();
    await unlink(lockPath);
  }
}
