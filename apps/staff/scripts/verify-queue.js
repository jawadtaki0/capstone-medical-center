import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { resolve, relative, isAbsolute, sep } from "node:path";
import { mkdir, open, unlink, access, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { _electron as electron } from "playwright";
import { readLauncherConfig } from "../../staff-api/scripts/launcher/configuration.js";

// Real desktop/API/transactions, synthetic TEST only. Never normal API, data, launcher or messages.
const args = process.argv.slice(2),
  interactive = args.includes("--interactive");
const increment5 = args.includes("--increment5");
const increment4 = args.includes("--increment4");
const increment3 = args.includes("--increment3");
const packageIndex = args.indexOf("--package");
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
const evidence = resolve(
    increment5
      ? ".local/queue-increment-5"
      : increment4
        ? ".local/queue-increment-4"
        : increment3
          ? ".local/queue-increment-3"
          : args.includes("--increment2")
            ? ".local/queue-increment-2"
            : ".local/queue-increment-1",
  ),
  lockPath = resolve(".local/professional-schedule-review/review.lock");
let lock,
  fixture,
  proxy,
  desktop,
  page,
  stage = "exclusive TEST review lock",
  checks = 0;
let unavailable = false,
  uncertain = false,
  checkInRequests = [];
const errors = [],
  external = [];
const good = (r) => {
  assert.equal(r.status, 200, r.body?.error?.code);
  return r.body;
};
const pass = (text) => {
  checks++;
  console.log(`PASS ${checks}: ${text}`);
};
try {
  await mkdir(evidence, { recursive: true });
  await mkdir(resolve(".local/professional-schedule-review"), {
    recursive: true,
  });
  lock = await open(lockPath, "wx");
  await lock.writeFile(
    JSON.stringify({ pid: process.pid, kind: "queue-synthetic-review" }),
  );
  stage = "owned TEST proxy";
  proxy = createServer(async (req, res) => {
    try {
      const parts = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 16384) throw Error("Oversize TEST request");
        parts.push(chunk);
      }
      if (!fixture || (unavailable && req.url.startsWith("/queue/"))) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              code: "authority_unavailable",
              message:
                "Owned TEST queue server unavailable. Refresh when ready.",
            },
          }),
        );
        return;
      }
      const body = bytes
        ? JSON.parse(Buffer.concat(parts).toString())
        : undefined;
      const result = await fixture.request(req.url, {
        method: req.method,
        token: req.headers.authorization?.replace(/^Bearer /, ""),
        ...(body ? { body } : {}),
      });
      if (
        ["/queue/checkIn", "/queue/transition", "/queue/admit"].includes(
          req.url,
        )
      ) {
        checkInRequests.push(body);
        if (uncertain && result.status === 200) {
          uncertain = false;
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
  const next = new Date(`${beirutClock(fixture.clock()).date}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + ((8 - next.getUTCDay()) % 7 || 7));
  const date = next.toISOString().slice(0, 10);
  // Winter review clock, visibly synthetic. Keeps manual review inside the check-in window.
  fixture.advance(
    new Date(`${date}T${increment5 ? "10:59" : "08:45"}:00+02:00`) -
      fixture.clock(),
  );
  const authority = await seedPublicationAuthority(fixture);
  good(await authority.publish(null));
  const actor = await fixture.account({
    roles: ["Receptionist"],
    username: "synthetic.queue.review",
  });
  await fixture.db.collection("operational_grants").insertOne({
    _id: actor.id,
    id: actor.id,
    scopeIds: ["clinic:synthetic"],
    revision: 1,
  });
  const bookings = [],
    admissionPatients = {};
  if (increment4) {
    await authority.save("professionals", {
      ...authority.profile,
      id: "doctor:restricted",
      name: "Dr. Synthetic Restricted",
    });
    await authority.save("sessions", {
      id: "session:restricted",
      scopeId: "clinic:synthetic",
      professionalId: "doctor:restricted",
      weekday: 1,
      startTime: "09:00",
      endTime: "11:00",
      capacity: 2,
      status: "active",
      appointmentRequired: true,
    });
    good(await authority.publish(date));
  }
  const adminPost = (action, body) =>
    fixture.request(`/bookings/${action}`, {
      method: "POST",
      token: authority.admin.token,
      body,
    });
  for (const label of increment4
    ? ["First", "Second", "Third", "Walkin", "Extra", "Full"]
    : ["First", "Second", "Third"]) {
    const record = {
      firstName: "Synthetic",
      fatherName: "Patient",
      lastName: label,
      motherFirstName: "Mother",
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
    const p = good(
      await fixture.request("/patients/create", {
        method: "POST",
        token: authority.admin.token,
        body: {
          record,
          reviewDigest: review.reviewDigest,
          duplicateOverride: {
            acknowledged: true,
            reason: "Distinct synthetic queue review patient",
          },
        },
      }),
    ).patient;
    if (["Walkin", "Extra", "Full"].includes(label)) {
      admissionPatients[label] = p;
      continue;
    }
    const input = {
      patientId: p.id,
      patientRevision: p.revision,
      date,
      scopeId: "clinic:synthetic",
      sourceSessionId: "session:synthetic",
    };
    const s = good(await adminPost("review", input)).session;
    bookings.push(
      good(
        await adminPost("confirm", {
          ...input,
          sessionVersion: s.version,
          idempotencyKey: randomUUID(),
        }),
      ).booking,
    );
  }
  await fixture.db
    .collection("bookings")
    .updateOne({ _id: bookings[1].id }, { $set: { source: "website" } });
  if (
    increment5 ||
    (interactive && (args.includes("--increment2") || increment3 || increment4))
  ) {
    const session = good(
      await fixture.request("/queue/sessions", {
        method: "POST",
        token: authority.admin.token,
        body: { date },
      }),
    ).sessions[0];
    for (const booking of increment3 || increment4
      ? [bookings[1], bookings[0], bookings[2]]
      : [bookings[1], bookings[0]])
      good(
        await fixture.request("/queue/checkIn", {
          method: "POST",
          token: authority.admin.token,
          body: {
            date,
            scopeId: session.scopeId,
            sourceSessionId: session.sourceSessionId,
            sessionVersion: session.scheduleSignature,
            bookingId: booking.id,
            expectedRevision: 0,
            idempotencyKey: randomUUID(),
          },
        }),
      );
  }
  stage = "isolated native Electron sign-in";
  const profile = resolve(evidence, `profile-${Date.now()}`);
  desktop = await electron.launch({
    ...(executable
      ? {
          executablePath: executable,
          args: ["--demo-loopback", `--user-data-dir=${profile}`],
        }
      : {
          args: [
            resolve("apps/staff"),
            "--demo-loopback",
            `--user-data-dir=${profile}`,
          ],
        }),
    env: { ...process.env, STAFF_API_URL: "http://127.0.0.1:4101" },
    timeout: 30000,
  });
  page = await desktop.firstWindow();
  page.setDefaultTimeout(12000);
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
  await page.getByRole("button", { name: "Queue", exact: true }).click();
  await page
    .getByRole("heading", { name: "Patient queue", exact: true })
    .waitFor();
  await page
    .getByLabel("Session date (Asia/Beirut)", { exact: true })
    .fill(date);
  await page
    .getByRole("button", { name: "Load sessions", exact: true })
    .click();
  await page
    .getByRole("heading", {
      name: increment5
        ? "Waiting \u00b7 2"
        : interactive &&
            (args.includes("--increment2") || increment3 || increment4)
          ? increment3 || increment4
            ? "Waiting \u00b7 3"
            : "Waiting \u00b7 2"
          : "Waiting \u00b7 0",
      exact: true,
    })
    .waitFor();
  pass(
    "Real Receptionist sign-in, explicit clinic scope, Queue navigation and authoritative dated-session selection",
  );
  if (interactive) {
    await desktop
      .browserWindow(page)
      .then((w) => w.evaluate((win) => win.setSize(1440, 1000)));
    console.log(
      increment5
        ? `INCREMENT 5 TEST REVIEW READY. ${date}, Dr. Synthetic Review, 09:00-11:00; TEST time 10:59 Beirut. Two Waiting; Third is unarrived. Type end here then Enter to advance ONLY this TEST clock to 11:00. In the app click Refresh queue then No-show. Follow docs/QUEUE_INCREMENT_5_REVIEW.md. A blank Enter closes this owned review.`
        : increment4
          ? `COMBINED QUEUE REVIEW READY. ${date}, Dr. Synthetic Review, 09:00-11:00; TEST clock 08:45 Beirut. Three patients already Waiting. Use More on a patient's row, Returned—join end on that absent row, Accept walk-in, and Admit extra today. No password entry needed. Follow docs/QUEUE_COMBINED_3_4_REVIEW.md. Press Enter here when finished to close this owned review.`
          : `SYNTHETIC TEST REVIEW READY. Selected ${date}, Dr. Synthetic Review, 09:00–11:00; frozen server time 08:45 Beirut. Three confirmed fictional bookings. Check in Second before First to observe arrival order. This is isolated port4101/TEST, not the normal shortcut. Press Enter here to close this owned review and clear only unprefixed TEST fixtures.`,
    );
    const input = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      for await (const line of input) {
        if (!line.trim()) break;
        if (increment5 && line.trim().toLowerCase() === "end") {
          fixture.advance(new Date(`${date}T11:00:00+02:00`) - fixture.clock());
          const result = await fixture.reconcileQueue();
          console.log(
            `TEST time 11:00 Beirut. ${result.marked} No-show recorded. Click Refresh queue, then No-show. Blank Enter here closes review.`,
          );
        } else
          console.log(
            "Type end to end this TEST session, or blank Enter to close.",
          );
      }
    } finally {
      input.close();
    }
  } else if (increment5) {
    stage = "packaged end-of-session reconciliation";
    await desktop
      .browserWindow(page)
      .then((w) => w.evaluate((win) => win.setSize(1440, 1000)));
    await page.screenshot({
      path: resolve(evidence, "before-end.png"),
      fullPage: true,
    });
    assert.equal((await fixture.reconcileQueue()).marked, 0);
    fixture.advance(60000);
    assert.equal((await fixture.reconcileQueue()).marked, 1);
    await page
      .getByRole("button", { name: "Refresh queue", exact: true })
      .click();
    await page.getByRole("button", { name: "No-show", exact: true }).click();
    const row = page
      .locator(".queue-history tbody tr")
      .filter({ hasText: "Synthetic Patient Third" });
    await row.waitFor();
    assert.equal(await row.locator("td").nth(0).textContent(), "—");
    assert.equal(await row.locator("td").nth(2).textContent(), "—");
    assert.equal(await page.locator(".queue-booked tbody button").count(), 0);
    assert.equal(
      await page
        .getByRole("button", { name: "Accept walk-in", exact: true })
        .isDisabled(),
      true,
    );
    assert.equal(
      await page
        .getByRole("button", { name: "Admit extra today", exact: true })
        .isDisabled(),
      true,
    );
    await page.screenshot({
      path: resolve(evidence, "no-show.png"),
      fullPage: true,
    });
    pass(
      "Exact end creates a truthful unnumbered No-show and closes all new arrival controls",
    );
    await page.getByRole("button", { name: /Call next/ }).click();
    await page
      .getByRole("button", { name: "Start consultation", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Complete consultation", exact: true })
      .click();
    await page
      .getByRole("heading", { name: "Active patient", exact: true })
      .waitFor();
    pass(
      "Already arrived patient completes consultation after end without releasing allowance",
    );
    await row.locator("summary").click();
    await row
      .getByRole("button", { name: "Correct missed arrival", exact: true })
      .click();
    await page
      .getByRole("heading", {
        name: "Correct No-show for Synthetic Patient Third",
        exact: true,
      })
      .waitFor();
    await page
      .getByLabel("Reason", { exact: true })
      .fill("Staff missed this patient's earlier arrival");
    await page
      .getByRole("button", { name: "Restore to waiting", exact: true })
      .click();
    assert.equal(
      await page
        .locator(".queue-check-in input[type=checkbox]")
        .evaluate((el) => el.validity.valueMissing),
      true,
    );
    await page
      .getByLabel("I confirm this patient arrived before the session ended", {
        exact: true,
      })
      .check();
    await page.screenshot({
      path: resolve(evidence, "correction.png"),
      fullPage: true,
    });
    for (const width of [1024, 768, 360]) {
      await desktop
        .browserWindow(page)
        .then((w) => w.evaluate((win, size) => win.setSize(size, 1000), width));
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
        false,
        `correction overflow ${width}`,
      );
      await page.screenshot({
        path: resolve(evidence, `correction-${width}.png`),
        fullPage: true,
      });
    }
    await desktop
      .browserWindow(page)
      .then((w) => w.evaluate((win) => win.setSize(1440, 1000)));
    pass("Correction form fits at 1440/1024/768/360 without page overflow");
    await page
      .getByRole("button", { name: "Restore to waiting", exact: true })
      .click();
    await page
      .getByRole("heading", { name: "Waiting · 2", exact: true })
      .waitFor();
    const waiting = page.locator(".queue-waiting tbody tr");
    assert.match(await waiting.nth(0).textContent(), /#02.*First/);
    assert.match(
      await waiting.nth(1).textContent(),
      /#03.*Third.*Earlier arrival reported/,
    );
    const corrected = await fixture.db
      .collection("bookings")
      .findOne({ _id: bookings[2].id });
    assert.equal(corrected.queue.checkedInAt, undefined);
    assert.equal(corrected.status, "confirmed");
    assert.equal(
      await fixture.db
        .collection("queue_changes")
        .countDocuments({ action: "no_show" }),
      1,
    );
    await page.screenshot({
      path: resolve(evidence, "after-correction.png"),
      fullPage: true,
    });
    pass(
      "Patient-bound correction requires earlier-arrival evidence and appends a first number without fabricated arrival or deleted history",
    );
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    pass(
      "No observed renderer/security exceptions or external renderer requests",
    );
  } else {
    async function arrive(b) {
      await page
        .locator(".queue-booked tbody tr")
        .filter({ hasText: b.bookingNumber })
        .getByRole("button", { name: /^Check in / })
        .click();
    }
    stage = "working check-in and server arrival order";
    await arrive(bookings[1]);
    await page
      .getByRole("heading", { name: "Waiting · 1", exact: true })
      .waitFor();
    assert.match(
      await page.locator(".queue-waiting tbody").innerText(),
      /#01[\s\S]*Synthetic Patient Second[\s\S]*Website booking/,
    );
    pass(
      "Screen → preload/main broker → authenticated API → real Mongo transaction returns first stable waiting number and website channel",
    );
    uncertain = true;
    await arrive(bookings[0]);
    await page.getByRole("alert").waitFor();
    const initialKey = checkInRequests.at(-1).idempotencyKey;
    await page
      .getByRole("button", {
        name: "Check in Synthetic Patient First",
        exact: true,
      })
      .click();
    await page
      .getByRole("heading", { name: "Waiting · 2", exact: true })
      .waitFor();
    assert.equal(checkInRequests.at(-1).idempotencyKey, initialKey);
    assert.equal(
      await fixture.db.collection("queue_changes").countDocuments(),
      2,
    );
    const waiting = page.locator(".queue-waiting tbody tr");
    assert.match(await waiting.nth(0).innerText(), /#01[\s\S]*Second/);
    assert.match(await waiting.nth(1).innerText(), /#02[\s\S]*First/);
    assert.equal(
      good(await adminPost("sessions", { date })).sessions[0].remaining,
      1,
    );
    assert.equal(
      await page
        .locator(".queue-history tbody")
        .getByText("Synthetic Patient First")
        .count(),
      0,
    );
    pass(
      "Lost-response retry keeps its key, creates no duplicate, preserves server arrival order and booking allowance",
    );
    if (args.includes("--increment2")) {
      await page.getByRole("button", { name: "Call next" }).click();
      await page
        .locator(".queue-active")
        .getByRole("heading", { name: "Called", exact: true })
        .waitFor();
      assert.equal(
        await page.getByRole("button", { name: "Call next" }).isDisabled(),
        true,
      );
      uncertain = true;
      await page
        .getByRole("button", { name: "Start consultation", exact: true })
        .click();
      await page.getByRole("alert").waitFor();
      const transitionKey = checkInRequests.at(-1).idempotencyKey;
      await page
        .getByRole("button", { name: "Start consultation", exact: true })
        .click();
      await page
        .locator(".queue-active")
        .getByRole("heading", { name: "In consultation", exact: true })
        .waitFor();
      assert.equal(checkInRequests.at(-1).idempotencyKey, transitionKey);
      await page
        .getByRole("button", { name: "Complete consultation", exact: true })
        .click();
      await page
        .locator(".queue-history tbody")
        .getByText("Synthetic Patient Second", { exact: true })
        .waitFor();
      assert.equal(
        await page
          .locator(".queue-active")
          .getByText("Synthetic Patient Second", { exact: true })
          .count(),
        0,
      );
      assert.equal(
        await page.getByRole("button", { name: "Call next" }).isDisabled(),
        false,
      );
      await page.getByRole("button", { name: "Call next" }).click();
      await page
        .locator(".queue-active")
        .getByText("Synthetic Patient First", { exact: true })
        .waitFor();
      assert.equal(
        good(await adminPost("sessions", { date })).sessions[0].remaining,
        1,
      );
      pass(
        "Called/start/completed history, same-key lost transition retry, occupied-slot controls, no active/history duplication and unchanged allowance",
      );
    }
    if (increment3 || increment4) {
      await arrive(bookings[2]);
      await page
        .getByRole("heading", { name: "Waiting \u00b7 3", exact: true })
        .waitFor();
      async function action(no, kind, details = {}) {
        await page.locator('.queue-panel[aria-busy="false"]').waitFor();
        if (increment4) {
          const person = await fixture.db
            .collection("bookings")
            .findOne({ date, "queue.number": Number(no) });
          if (kind === "return") {
            const row = page
              .locator(".queue-absent tbody tr")
              .filter({ hasText: person.patientName });
            await row
              .getByRole("button", { name: /Returned.*join end/ })
              .click();
          } else {
            const summary = page.getByLabel(
              `More actions for #${no} ${person.patientName}`,
              { exact: true },
            );
            await summary.click();
            const menu = summary.locator("..");
            await menu
              .getByRole("button", {
                name: {
                  absent: "Mark absent",
                  left: "Mark as left",
                  outOfOrder: "Call this patient instead",
                  correct: "Correct last change",
                }[kind],
                exact: true,
              })
              .click();
          }
          if (["outOfOrder", "correct"].includes(kind)) {
            assert.equal(
              await page.getByLabel("Queue patient", { exact: true }).count(),
              0,
            );
            assert.equal(
              await page.getByLabel("Queue action", { exact: true }).count(),
              0,
            );
            await page
              .getByLabel("Reason", { exact: true })
              .fill("Synthetic professional instruction / correction");
            if (kind === "outOfOrder")
              await page
                .getByRole("checkbox", {
                  name: "The professional instructed this call",
                  exact: true,
                })
                .check();
            if (kind === "outOfOrder")
              await page.screenshot({
                path: resolve(evidence, "contextual-call-controls.png"),
                fullPage: true,
              });
            const submit =
              kind === "outOfOrder"
                ? page.getByRole("button", {
                    name: "Call patient",
                    exact: true,
                  })
                : page.getByRole("button", { name: /^Undo / });
            if (details.lost) uncertain = true;
            await submit.click();
            if (details.lost) {
              await page.getByRole("alert").waitFor();
              const key = checkInRequests.at(-1).idempotencyKey;
              await submit.click();
              await page
                .getByRole("heading", { name: "Waiting \u00b7 3", exact: true })
                .waitFor();
              assert.equal(checkInRequests.at(-1).idempotencyKey, key);
            }
            if (details.refused) {
              await page.getByRole("alert").waitFor();
              await page
                .getByRole("button", { name: "Cancel", exact: true })
                .click();
            } else await submit.waitFor({ state: "hidden" });
          }
          await page.locator('.queue-panel[aria-busy="false"]').waitFor();
          return;
        }
        if (
          kind === "correct" &&
          (await page
            .locator(".queue-active")
            .getByText(`#${no}`, { exact: true })
            .count())
        )
          await page
            .getByRole("button", { name: "Correct status", exact: true })
            .click();
        else
          await page
            .getByRole("button", { name: `Actions for #${no}`, exact: true })
            .click();
        await page
          .getByLabel("Queue action", { exact: true })
          .selectOption(kind);
        if (["correct", "outOfOrder"].includes(kind))
          await page
            .getByLabel("Reason", { exact: true })
            .fill("Synthetic review reason");
        if (kind === "outOfOrder")
          await page
            .getByRole("checkbox", {
              name: "The professional instructed this out-of-order call",
            })
            .check();
        if (details.lost) uncertain = true;
        const submit = page.getByRole("button", {
          name: "Apply queue action",
          exact: true,
        });
        await submit.click();
        if (details.lost) {
          await page.getByRole("alert").waitFor();
          await submit.click();
        }
        if (details.refused) {
          await page.getByRole("alert").waitFor();
          await page
            .getByRole("button", { name: "Cancel", exact: true })
            .click();
        } else await submit.waitFor({ state: "hidden" });
        await page.locator('.queue-panel[aria-busy="false"]').waitFor();
      }
      await action("01", "absent");
      await page
        .locator(".queue-absent tbody")
        .getByText("Synthetic Patient Second", { exact: true })
        .waitFor();
      await action("01", "return");
      assert.match(
        await page.locator(".queue-waiting tbody").innerText(),
        /#02[\s\S]*#03[\s\S]*#01/,
      );
      await action("01", "outOfOrder");
      await page
        .locator(".queue-active")
        .getByText("Synthetic Patient Second", { exact: true })
        .waitFor();
      await action("01", "correct", { lost: true });
      await action("01", "outOfOrder");
      await page
        .getByRole("button", { name: "Start consultation", exact: true })
        .click();
      await page
        .locator(".queue-active")
        .getByRole("heading", { name: "In consultation", exact: true })
        .waitFor();
      await page
        .getByRole("button", { name: "Complete consultation", exact: true })
        .click();
      await page
        .locator(".queue-history tbody")
        .getByText("Synthetic Patient Second", { exact: true })
        .waitFor();
      await page.getByRole("button", { name: "Call next" }).click();
      await page
        .locator(".queue-active")
        .getByText("Synthetic Patient First", { exact: true })
        .waitFor();
      await action("03", "left");
      await action("01", "correct", { refused: true });
      await page.getByRole("button", { name: "Left", exact: true }).click();
      await page
        .locator(".queue-history tbody")
        .getByText("Synthetic Patient Third", { exact: true })
        .waitFor();
      assert.equal(
        good(await adminPost("sessions", { date })).sessions[0].remaining,
        1,
      );
      const corrections = await fixture.db
        .collection("queue_changes")
        .countDocuments({ action: "correct" });
      assert.equal(corrections, 1);
      pass(
        "Absence/return-to-end with two waiting patients, Left history, instructed out-of-order call, same-key correction retry and refusal after intervening action; allowance unchanged",
      );
    }
    if (increment4) {
      async function selectArrival(label, extra = false, lost = false) {
        await page
          .getByRole("button", {
            name: extra ? "Admit extra today" : "Accept walk-in",
            exact: true,
          })
          .click();
        if (extra) {
          await page
            .getByLabel("Reason for extra admission", { exact: true })
            .fill("Professional agreed today");
          await page
            .getByRole("checkbox", {
              name: "The professional agreed to this extra admission today",
              exact: true,
            })
            .check();
        }
        const registry = page.locator(".queue-admission .patient-registry");
        await registry.getByLabel("Last name", { exact: true }).fill(label);
        await registry
          .getByRole("button", { name: "Search patients", exact: true })
          .click();
        await registry
          .getByRole("button", {
            name: `Choose patient ${admissionPatients[label].patientNumber}`,
            exact: true,
          })
          .click();
        await page.screenshot({
          path: resolve(
            evidence,
            extra ? "extra-admission-controls.png" : "walk-in-controls.png",
          ),
          fullPage: true,
        });
        if (lost) uncertain = true;
        await page
          .locator(".queue-admission")
          .getByRole("button", {
            name: extra ? "Admit extra today" : "Accept walk-in",
            exact: true,
          })
          .click();
        if (lost) {
          await page.locator(".queue-admission").getByRole("alert").waitFor();
          const key = checkInRequests.at(-1).idempotencyKey;
          await page
            .locator(".queue-admission")
            .getByRole("button", {
              name: extra ? "Admit extra today" : "Accept walk-in",
              exact: true,
            })
            .click();
          await page.locator(".queue-admission").waitFor({ state: "hidden" });
          assert.equal(checkInRequests.at(-1).idempotencyKey, key);
        }
      }
      await selectArrival("Walkin", false, true);
      await page
        .locator(".queue-waiting tbody")
        .getByText("Synthetic Patient Walkin", { exact: true })
        .waitFor();
      assert.equal(
        good(await adminPost("sessions", { date })).sessions.find(
          (s) => s.sourceSessionId === "session:synthetic",
        ).remaining,
        0,
      );
      await selectArrival("Full");
      await page
        .locator(".queue-admission")
        .getByRole("alert")
        .filter({ hasText: "full" })
        .waitFor();
      await page
        .getByRole("button", { name: "Cancel admission", exact: true })
        .click();
      await selectArrival("Extra", true);
      await page
        .locator(".queue-waiting tbody")
        .getByText("Synthetic Patient Extra", { exact: true })
        .waitFor();
      assert.equal(
        await fixture.db
          .collection("bookings")
          .countDocuments({ status: "confirmed", admissionKind: "extra" }),
        1,
      );
      assert.equal(
        good(await adminPost("sessions", { date })).sessions.find(
          (s) => s.sourceSessionId === "session:synthetic",
        ).remaining,
        0,
      );
      await page
        .getByLabel("Professional", { exact: true })
        .selectOption("doctor:restricted");
      await page.locator('.queue-panel[aria-busy="false"]').waitFor();
      await selectArrival("Full");
      await page
        .locator(".queue-admission")
        .getByRole("alert")
        .filter({ hasText: "requires an appointment" })
        .waitFor();
      await page
        .getByRole("button", { name: "Cancel admission", exact: true })
        .click();
      await page
        .getByLabel("Professional", { exact: true })
        .selectOption("doctor:synthetic");
      await page
        .getByRole("heading", { name: "Waiting \u00b7 2", exact: true })
        .waitFor();
      await page
        .getByRole("button", { name: "Admit extra today", exact: true })
        .click();
      await page
        .getByLabel("Reason for extra admission", { exact: true })
        .fill("Professional agreed to this new patient's extra admission");
      await page
        .getByRole("checkbox", {
          name: "The professional agreed to this extra admission today",
          exact: true,
        })
        .check();
      const newRegistry = page.locator(".queue-admission .patient-registry");
      await newRegistry
        .getByLabel("Last name", { exact: true })
        .fill("Fresharrival");
      await newRegistry
        .getByRole("button", { name: "Search patients", exact: true })
        .click();
      await newRegistry
        .getByRole("button", { name: "Register new patient", exact: true })
        .click();
      const dialog = page.getByRole("dialog");
      const { PATIENT_LABELS } = await import("../shared/patient-input.js");
      const newRecord = {
        firstName: "Fresh",
        fatherName: "Parent",
        lastName: "Fresharrival",
        motherFirstName: "Guardian",
        dateOfBirth: "2001-01-01",
        phone: "71 123 459",
        gender: "female",
      };
      for (const [field, value] of Object.entries(newRecord)) {
        if (field === "gender")
          await dialog
            .getByLabel(PATIENT_LABELS[field], { exact: true })
            .selectOption(value);
        else
          await dialog
            .getByLabel(PATIENT_LABELS[field], { exact: true })
            .fill(value);
      }
      await dialog
        .getByRole("button", { name: "Check duplicates", exact: true })
        .click();
      await dialog
        .getByRole("heading", { name: "Duplicate review", exact: true })
        .waitFor();
      if (await dialog.getByRole("checkbox").count()) {
        await dialog.getByRole("checkbox").check();
        await dialog
          .getByLabel("Reason for continuing with this patient record", {
            exact: true,
          })
          .fill("Distinct synthetic review patient");
      }
      await dialog
        .getByRole("button", {
          name: "Register and admit extra today",
          exact: true,
        })
        .click();
      await dialog.waitFor({ state: "hidden" });
      await page
        .getByRole("heading", { name: "Waiting \u00b7 3", exact: true })
        .waitFor();
      assert.equal(
        await fixture.db
          .collection("patients")
          .countDocuments({ lastName: "Fresharrival" }),
        1,
      );
      assert.equal(
        await fixture.db
          .collection("bookings")
          .countDocuments({ admissionKind: "extra" }),
        2,
      );
      assert.equal(
        good(await adminPost("sessions", { date })).sessions.find(
          (s) => s.sourceSessionId === "session:synthetic",
        ).remaining,
        0,
      );
      pass(
        "Existing registry search/selection, ordinary walk-in last place, full/restricted refusals, explicit extra today, shared numbering and unchanged ordinary allowance",
      );
    }
    stage = "native layout and keyboard";
    for (const width of [1440, 1024, 768, 360]) {
      await desktop
        .browserWindow(page)
        .then((w) => w.evaluate((win, size) => win.setSize(size, 1000), width));
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
        false,
        `page overflow ${width}`,
      );
      await page.screenshot({
        path: resolve(
          evidence,
          `${executable ? "packaged" : "development"}-${width}.png`,
        ),
        fullPage: true,
      });
    }
    await page
      .getByRole("button", { name: "Refresh queue", exact: true })
      .focus();
    await page.keyboard.press("Tab");
    assert.equal(
      await page
        .getByRole("button", { name: "Accept walk-in", exact: true })
        .evaluate((el) => el === document.activeElement),
      true,
    );
    pass(
      "Native layouts at 1440/1024/768/360 fit without page overflow; keyboard reaches check-in; app minimum width is 360",
    );
    stage = "queue outage and retry";
    unavailable = true;
    await page
      .getByRole("button", { name: "Refresh queue", exact: true })
      .click();
    await page.getByRole("alert").filter({ hasText: "unavailable" }).waitFor();
    assert.equal(
      await page
        .locator(".queue-waiting tbody")
        .getByText("Synthetic Patient First")
        .count(),
      0,
    );
    unavailable = false;
    await page
      .getByRole("button", { name: "Refresh queue", exact: true })
      .click();
    await page
      .getByRole("heading", {
        name: increment4
          ? "Waiting \u00b7 3"
          : increment3
            ? "Waiting \u00b7 0"
            : args.includes("--increment2")
              ? "Waiting \u00b7 0"
              : "Waiting \u00b7 2",
        exact: true,
      })
      .waitFor();
    pass(
      "Unavailable API clears the authoritative list rather than claiming zero; refresh restores persisted arrivals",
    );
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    pass(
      "No observed renderer/security exceptions or external renderer requests",
    );
  }
  await writeFile(
    resolve(
      evidence,
      `${executable ? "packaged" : "development"}-results.json`,
    ),
    JSON.stringify(
      { checks, interactive, errors, external, syntheticOnly: true, date },
      null,
      2,
    ),
  );
} catch (error) {
  if (page)
    await page
      .screenshot({ path: resolve(evidence, "failure.png"), fullPage: true })
      .catch(() => {});
  console.error(`FAIL at ${stage}: ${error.message}`);
  process.exitCode = 1;
} finally {
  await desktop?.close().catch(() => {});
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
