import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { access, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { readLauncherConfig } from "../../staff-api/scripts/launcher/configuration.js";
import {
  patientToday,
  shiftPatientYear,
} from "../../staff/shared/patient-input.js";
import { createApp } from "../src/app.js";
import {
  createPublicIntake,
  ensureIntakeIndexes,
  PUBLIC_INTAKE_COLLECTIONS,
} from "../src/website-requests.js";
import {
  ensurePatientAccountIndexes,
  patientAccountRouter,
} from "../src/patient-accounts.js";

const port = 5204;
const verifyClinicalBoundary = process.argv.includes(
  "--verify-clinical-boundary",
);
const origin = `http://127.0.0.1:${port}`;
const artifact = resolve(".local/patient-accounts/nov13-phone-verification");
const websiteDirectory = resolve(artifact, "web");
await access(resolve(websiteDirectory, "index.html"));
process.env.CAPSTONE_STAFF_RUNTIME_DIR = (
  await readLauncherConfig()
).runtimeDirectory;
const { connectStaffDatabase } = await import("../../staff-api/src/db.js");
const { assertIsolatedTestTarget, TEST_DATABASE } =
  await import("../../staff-api/test/helpers/security-fixture.js");
const connection = await connectStaffDatabase({
  database: TEST_DATABASE,
  demoMode: true,
  initializeIndexes: false,
});
const names = [
  "patient_accounts",
  "patient_account_signups",
  "patient_account_limits",
  ...PUBLIC_INTAKE_COLLECTIONS,
];
const prefix =
  "patient_access_review_" + randomUUID().replaceAll("-", "") + "_";
const mailbox = [];
let offset = 0;
let server;
let staffFixture, desktop;
const db = {
  collection(name) {
    assertIsolatedTestTarget(connection);
    assert.ok(names.includes(name));
    return connection.db.collection(prefix + name);
  },
};
try {
  await ensurePatientAccountIndexes(db);
  await ensureIntakeIndexes(db);
  const today = patientToday();
  let hoursKnown = true;
  const nextSession = new Date(Date.parse(today + "T00:00:00Z") + 86400000);
  if (verifyClinicalBoundary)
    nextSession.setUTCDate(
      nextSession.getUTCDate() + ((8 - nextSession.getUTCDay()) % 7),
    );
  const date = nextSession.toISOString().slice(0, 10);
  const professional = {
    id: verifyClinicalBoundary ? "doctor:synthetic" : "review-doctor",
    name: "Dr. Cedar Review",
    kind: "doctor",
    specialty: "Family medicine",
    avatarVariant: "female",
  };
  const selection = {
    date,
    professionalId: professional.id,
    sourceSessionId: verifyClinicalBoundary
      ? "session:synthetic"
      : "review-session",
    startTime: "09:00",
    endTime: "11:00",
  };
  const reviewSession = {
    ...selection,
    ...(verifyClinicalBoundary
      ? { scopeId: "clinic:synthetic", appointmentRequired: false }
      : {}),
    kind: professional.kind,
    professionalName: professional.name,
    specialty: professional.specialty,
    avatarVariant: professional.avatarVariant,
  };
  const requestKey = randomBytes(32);
  const intake = createPublicIntake({
    db,
    client: connection.client,
    key: requestKey,
    sessionReader: async (day) => (day === date ? [reviewSession] : []),
    professionalReader: async () => [professional],
    upcomingReader: async ({ professionalId, fromDate }) => ({
      fromDate,
      throughDate: date,
      nextDate: null,
      nextAfter: null,
      sessions:
        professionalId === professional.id && fromDate <= date
          ? [reviewSession]
          : [],
    }),
  });
  const patientAccounts = patientAccountRouter({
    db,
    client: connection.client,
    publicOrigin: origin,
    intake,
    phoneKey: randomBytes(32),
    clock: () => new Date(Date.now() + offset),
    async deliver(message) {
      if (!/^[a-z0-9.+_-]+@example\.invalid$/.test(message.to))
        throw new Error(
          "Use fictional review addresses ending in @example.invalid.",
        );
      mailbox.push(message);
    },
  });
  const credential = randomBytes(32).toString("base64url");
  const app = createApp({
    websiteDirectory,
    patientAccounts,
    websiteRequests: { service: intake, credential },
    clientOrigin: origin,
    scheduleReader: async (day) => ({
      date: day,
      timeZone: "Asia/Beirut",
      publicationStatus: hoursKnown ? "published" : "unpublished",
      centerClosed: hoursKnown ? day === today : null,
      centerHours: null,
      doctorSessions: [],
      specialistSessions: [],
      otherServices: [],
    }),
    professionalsReader: async () => {
      throw new Error("Account-only review");
    },
    databaseHealthReader: async () => "connected",
  });
  // The review mailbox exists only in this loopback operator.
  const { createServer } = await import("node:http");
  server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/__review/mail") {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
      });
      res.end(
        "<!doctype html><html lang=en><title>Cedar review inbox</title><h1>Synthetic Cedar inbox</h1>" +
          (mailbox.length
            ? "<ul>" +
              mailbox
                .toReversed()
                .map(
                  ({ to, purpose, link }) =>
                    `<li>${to} — <a href="${link.replaceAll("&", "&amp;")}">${purpose}</a></li>`,
                )
                .join("") +
              "</ul>"
            : "<p>No email links yet. Refresh after submitting the Cedar form.</p>"),
      );
      return;
    }
    app(req, res);
  });
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  const reviewPassword = "Cedar fictional review passphrase";
  const reviewPatient = {
    firstName: "Lea",
    fatherName: "Sami",
    lastName: "Demo",
    motherFirstName: "Rana Sample",
    dateOfBirth: "2017-04-09",
    gender: "female",
  };
  async function reviewCall(path, body, { status = 200, cookie = "" } = {}) {
    const response = await fetch(origin + "/api/" + path, {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        Cookie: cookie,
      },
      body: JSON.stringify(body),
    });
    const result = await response.json();
    assert.equal(
      response.status,
      status,
      `${path}: ${result.error ?? response.status}`,
    );
    return {
      result,
      cookie: response.headers.get("set-cookie")?.split(";")[0],
    };
  }
  const callAccount = (path, body, options) =>
    reviewCall("patient-account/" + path, body, options);
  async function seedAccount(label, phone, verified) {
    const email = `${label}@example.invalid`;
    await callAccount("signup", {
      email,
      relationship: "child",
      phone,
      patient: reviewPatient,
    });
    const token = new URLSearchParams(
      new URL(mailbox.at(-1).link).hash.slice(1),
    ).get("token");
    await callAccount("activate", {
      token,
      password: reviewPassword,
      username: label,
    });
    if (verified) {
      assertIsolatedTestTarget(connection);
      await db
        .collection("patient_accounts")
        .updateOne({ email }, { $set: { verifiedWhatsAppPhone: phone } });
    }
    return {
      email,
      ...(await callAccount("signin", {
        identifier: email,
        password: reviewPassword,
      })),
    };
  }
  if (process.argv.includes("--verify")) {
    const p1 = "Cedar fictional review passphrase";
    const p2 = "Cedar fictional replacement passphrase";
    const first = "cedar-review@example.invalid";
    const next = "cedar-replacement@example.invalid";
    const latestToken = () =>
      new URLSearchParams(new URL(mailbox.at(-1).link).hash.slice(1)).get(
        "token",
      );
    async function call(action, input, status = 200, cookie = "") {
      const response = await fetch(`${origin}/api/patient-account/${action}`, {
        ...(input && { method: "POST", body: JSON.stringify(input) }),
        headers: {
          "Content-Type": "application/json",
          Origin: origin,
          Cookie: cookie,
        },
      });
      assert.equal(response.status, status, `${action}: ${response.status}`);
      assert.equal(response.headers.get("cache-control"), "no-store");
      return {
        ...(await response.json()),
        cookie: response.headers.get("set-cookie")?.split(";")[0],
      };
    }
    const patient = {
      firstName: "Lea",
      fatherName: "Sami",
      lastName: "Demo",
      motherFirstName: "Rana Sample",
      dateOfBirth: "2017-04-09",
      gender: "female",
      phone: "+96170123456",
    };
    const signup = (email) => ({
      email,
      phone: "+96171123456",
      relationship: "child",
      patient,
    });
    await call("signup", { ...signup(first), phone: "" }, 400);
    await call(
      "signup",
      { ...signup(first), patient: { ...patient, dateOfBirth: "2099-01-01" } },
      400,
    );
    const eighteenth = shiftPatientYear(patientToday(), -18);
    const youngerDate = new Date(eighteenth + "T00:00:00Z");
    youngerDate.setUTCDate(youngerDate.getUTCDate() + 1);
    const younger = youngerDate.toISOString().slice(0, 10);
    const boundary = await call(
      "signup",
      {
        ...signup(first),
        patient: { ...patient, dateOfBirth: eighteenth },
      },
      400,
    );
    assert.equal(boundary.error, "invalid_child_birth_date");
    await call("signup", {
      ...signup(first),
      relationship: "self",
      patient: { ...patient, dateOfBirth: eighteenth },
    });
    assert.equal(await db.collection("patient_accounts").countDocuments(), 0);
    const activation = latestToken();
    await call("signin", { identifier: first, password: p1 }, 401);
    await call("activate", { token: activation, password: p1 }, 400);
    await call(
      "activate",
      { token: activation, password: p1, username: "bad name" },
      400,
    );
    await call("activate", {
      token: activation,
      password: p1,
      username: " Review.Patient ",
    });
    const self = await db
      .collection("patient_accounts")
      .findOne({ email: first });
    assert.equal(self.pendingPhone, patient.phone);
    assert.equal(self.profiles[0].phone, patient.phone);
    await call(
      "activate",
      { token: activation, password: p1, username: "other.name" },
      400,
    );
    const b = await call("signin", { identifier: first, password: p1 });
    assert.equal(b.account.username, "review.patient");
    const a = await call("signin", {
      identifier: "Review.Patient",
      password: p1,
    });
    await call(
      "replace-email",
      { email: next, password: "incorrect" },
      401,
      a.cookie,
    );
    await call("replace-email", { email: next, password: p1 }, 200, a.cookie);
    assert.equal(
      (await call("session", null, 200, a.cookie)).account.email,
      first,
    );
    await call("signin", { identifier: next, password: p1 }, 401);
    const replacement = latestToken();
    await call("verify-email", { token: replacement });
    await call("verify-email", { token: replacement }, 400);
    assert.equal(
      (await call("session", null, 200, a.cookie)).account.email,
      next,
    );
    await call("signin", { identifier: first, password: p1 }, 401);
    const beforeUnknown = mailbox.length;
    await call("recover", { email: first });
    assert.equal(mailbox.length, beforeUnknown);
    await call("recover", { email: next });
    const reset = latestToken();
    await call("reset", { token: reset, password: p2 });
    await call("reset", { token: reset, password: p2 }, 400);
    for (const cookie of [a.cookie, b.cookie])
      assert.equal((await call("session", null, 200, cookie)).account, null);
    await call("signin", { identifier: next, password: p1 }, 401);
    const c = await call("signin", { identifier: next, password: p2 });
    const d = await call("signin", { identifier: next, password: p2 });
    await call("delete", { password: p1 }, 401, c.cookie);
    await call("delete", { password: p2 }, 200, c.cookie);
    for (const cookie of [c.cookie, d.cookie])
      assert.equal((await call("session", null, 200, cookie)).account, null);
    assert.equal(await db.collection("patient_accounts").countDocuments(), 0);
    console.log(
      "PASS activation and replay, username and email sign-in, replacement and re-authentication, recovery, all-session revocation, deletion",
    );

    const rejected = await fetch(origin + "/api/patient-account/signup", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: `http://localhost:${port}`,
      },
      body: JSON.stringify({ identifier: first }),
    });
    assert.equal(rejected.status, 403);
    await call("signup", signup("phone@example.invalid"));
    const phoneToken = latestToken();
    const { suggestions: childSuggestions } = await call(
      "username-suggestions",
      {
        token: phoneToken,
      },
    );
    assert.equal(childSuggestions[0], "lea.demo");
    assert.ok(childSuggestions.every((name) => name.startsWith("lea.demo")));
    const arabicPatient = { ...patient, firstName: "ليا", lastName: "مثال" };
    await call("signup", {
      ...signup("shared@example.invalid"),
      patient: arabicPatient,
    });
    const sharedToken = latestToken();
    const { suggestions: arabicSuggestions } = await call(
      "username-suggestions",
      { token: sharedToken },
    );
    assert.equal(arabicSuggestions[0], "ليا.مثال");
    const competing = [
      { token: phoneToken, password: p1, username: "review.patient" },
      { token: sharedToken, password: p2, username: "REVIEW.PATIENT" },
    ];
    const statuses = await Promise.all(
      competing.map(async (body) => {
        const response = await fetch(origin + "/api/patient-account/activate", {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: origin },
          body: JSON.stringify(body),
        });
        if (response.status === 409)
          assert.equal((await response.json()).error, "username_taken");
        return response.status;
      }),
    );
    assert.deepEqual(statuses.toSorted(), [200, 409]);
    const retry = competing[statuses.indexOf(409)];
    const { suggestions } = await call("username-suggestions", {
      token: retry.token,
    });
    assert.equal(suggestions.length, 3);
    await call("activate", { ...retry, username: suggestions[0] });
    await call("activate", { ...retry, username: suggestions[1] }, 400);
    const remainingEmail =
      statuses[0] === 409 ? "phone@example.invalid" : "shared@example.invalid";
    await assert.rejects(
      db
        .collection("patient_accounts")
        .updateOne(
          { email: remainingEmail },
          { $set: { username: "REVIEW.PATIENT" } },
        ),
      { code: 11000 },
    );
    await call("signin", { identifier: "+96171123456", password: p1 }, 401);
    await db
      .collection("patient_accounts")
      .updateOne(
        { email: "phone@example.invalid" },
        { $set: { verifiedPersonalPhone: "+96171123456" } },
      );
    await call("signin", { identifier: "+96171123456", password: p1 });
    await call("signin", { identifier: "+96171123456", password: p2 }, 401);
    console.log(
      "PASS English and Arabic child-name suggestions, required username, case-insensitive concurrent conflict and retry",
    );
    await assert.rejects(
      db
        .collection("patient_accounts")
        .updateOne(
          { email: "shared@example.invalid" },
          { $set: { verifiedPersonalPhone: "+96171123456" } },
        ),
      { code: 11000 },
    );
    await call("signup", signup("expired@example.invalid"));
    offset += 31 * 60_000;
    await call(
      "activate",
      { token: latestToken(), password: p1, username: "expired.demo" },
      400,
    );
    console.log(
      "PASS exact origin, unverified and shared phone refused as aliases, unique personal phone accepted, concurrent and expired activation guarded",
    );

    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ channel: "msedge" });
    try {
      await mkdir(resolve(artifact, "evidence"), { recursive: true });
      const page = await browser.newPage({
        viewport: { width: 1440, height: 1000 },
      });
      await page.goto(origin + "/");
      await page.getByRole("link", { name: "Sign in", exact: true }).click();
      await page
        .getByRole("button", { name: "Sign in", exact: true })
        .waitFor();
      await page.keyboard.press("Tab");
      await page.getByLabel("Email, username, or verified phone").focus();
      assert.equal(await page.locator("input:focus-visible").count(), 1);
      await page
        .getByRole("link", { name: "Create account", exact: true })
        .hover();
      async function verifyTypography() {
        const result = await page.evaluate(async () => {
          const faces = await document.fonts.load(
            '16px "Cedar Source Sans"',
            "Cedar",
          );
          const shell = document.querySelector(".public-site");
          const account = document.querySelector(".request-shell");
          const font = getComputedStyle(shell).fontFamily;
          const labels = [...account.querySelectorAll("label")];
          return {
            font,
            loaded: faces.some((face) => face.status === "loaded"),
            mismatches: [
              ...account.querySelectorAll(
                "h1, p, label, input, button, select, option, .MuiAlert-message",
              ),
            ]
              .filter(
                (element) => getComputedStyle(element).fontFamily !== font,
              )
              .map((element) => element.tagName),
            wrongLabels: labels.filter(
              (label) => getComputedStyle(label).color !== "rgb(34, 107, 157)",
            ).length,
          };
        });
        assert.match(result.font, /Cedar Source Sans.*Segoe UI/);
        assert.equal(result.loaded, true);
        assert.deepEqual(result.mismatches, []);
        assert.equal(result.wrongLabels, 0);
      }
      async function verifySignInLabels() {
        const identifier = page.locator('input[name="identifier"]');
        const password = page.locator('input[name="password"]');
        const label = (input) => input.locator("xpath=../..").locator("label");
        for (const input of [identifier, password]) {
          assert.equal(await label(input).getAttribute("data-shrink"), "false");
        }
        await page.getByRole("combobox", { name: "Page language" }).focus();
        await page.keyboard.press("Tab");
        assert.equal(
          await identifier.evaluate(
            (input) => input === document.activeElement,
          ),
          true,
        );
        assert.equal(
          await label(identifier).getAttribute("data-shrink"),
          "true",
        );
        assert.equal(
          await label(identifier).evaluate(
            (element) => getComputedStyle(element).color,
          ),
          "rgb(34, 107, 157)",
        );
        await identifier.blur();
        for (const [input, value] of [
          [identifier, "preview@example.invalid"],
          [password, p1],
        ]) {
          await input.click();
          assert.equal(await label(input).getAttribute("data-shrink"), "true");
          await input.fill(value);
          await input.blur();
          assert.equal(await label(input).getAttribute("data-shrink"), "true");
          await input.fill("");
          await input.blur();
          assert.equal(await label(input).getAttribute("data-shrink"), "false");
        }
      }
      async function capture(screen) {
        for (const field of await page
          .locator("form input.MuiOutlinedInput-input")
          .all()) {
          await field.focus();
          const focus = await field.evaluate((input) => ({
            outline: getComputedStyle(input).outlineStyle,
            border: getComputedStyle(
              input.parentElement.querySelector("fieldset"),
            ).borderTopColor,
          }));
          assert.deepEqual(focus, {
            outline: "none",
            border: "rgb(65, 70, 75)",
          });
          await field.blur();
        }
        for (const [size, width] of [
          ["desktop", 1440],
          ["mobile", 390],
        ]) {
          await page.setViewportSize({ width, height: 900 });
          await verifyTypography();
          if (screen.startsWith("sign-in")) await verifySignInLabels();
          assert.ok(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth,
            ),
          );
          await page.evaluate(() =>
            window.scrollTo({ top: 0, behavior: "instant" }),
          );
          await page.screenshot({
            path: resolve(artifact, "evidence", screen + "-" + size + ".png"),
            fullPage: true,
            animations: "disabled",
          });
        }
        await page.setViewportSize({ width: 1440, height: 1000 });
      }
      assert.equal(
        await page.locator("input.MuiOutlinedInput-input").count(),
        2,
      );
      const submitSignup = page.getByRole("button", {
        name: "Continue",
        exact: true,
      });
      const createLink = page.getByRole("link", {
        name: "Create account",
        exact: true,
      });
      const recoveryLink = page.getByRole("link", {
        name: "Forgot password?",
        exact: true,
      });
      await recoveryLink.waitFor();
      assert.equal(
        await recoveryLink.evaluate((link) =>
          Boolean(
            link.compareDocumentPosition(
              link.closest("form").querySelector('button[type="submit"]'),
            ) & Node.DOCUMENT_POSITION_FOLLOWING,
          ),
        ),
        true,
      );
      await capture("sign-in");
      await createLink.click();
      const phones = page.getByRole("textbox", {
        name: "Phone number",
        exact: true,
      });
      assert.equal(await phones.count(), 1);
      assert.equal(
        await page
          .getByRole("group", { name: "Patient details", exact: true })
          .getByRole("textbox", { name: "Phone number", exact: true })
          .count(),
        1,
      );
      await capture("signup-self");
      const openCalendar = page.getByRole("button", {
        name: "Open calendar: Date of birth",
        exact: true,
      });
      await openCalendar.click();
      const calendar = page.getByRole("dialog");
      const yearEntry = calendar.getByLabel("Year", { exact: true });
      assert.equal(await yearEntry.getAttribute("list"), null);
      await yearEntry.fill("1900");
      await yearEntry.press("Enter");
      assert.equal(await yearEntry.getAttribute("aria-invalid"), "false");
      await calendar
        .getByRole("button", { name: "Cancel", exact: true })
        .click();
      await page.locator('select[name="relationship"]').selectOption("child");
      await page.getByText("For patients under 18", { exact: true }).waitFor();
      assert.equal(await phones.count(), 1);
      assert.equal(
        await page
          .getByRole("group", { name: "Account contact", exact: true })
          .getByRole("textbox", { name: "Phone number", exact: true })
          .count(),
        1,
      );
      await page
        .getByLabel("Email address", { exact: false })
        .fill("browser@example.invalid");
      await submitSignup.click();
      await page
        .getByText("Enter a real date of birth", { exact: false })
        .waitFor();
      await page
        .getByLabel("First name", { exact: true })
        .fill(patient.firstName);
      await page.getByLabel("Father’s name").fill(patient.fatherName);
      await page.getByLabel("Last name").fill(patient.lastName);
      await page
        .getByLabel("Mother’s maiden name")
        .fill(patient.motherFirstName);
      await page
        .getByLabel("Date of birth", { exact: true })
        .fill(patient.dateOfBirth);
      await page
        .getByLabel("Gender", { exact: true })
        .selectOption(patient.gender);
      await phones.fill("+96171123456");
      const birthDate = page.getByLabel("Date of birth", { exact: true });
      const earliestYear = Number(younger.slice(0, 4));
      const tooOldYear = String(earliestYear - 1);
      await birthDate.fill(`${tooOldYear}-12-31`);
      await openCalendar.click();
      assert.equal(await yearEntry.inputValue(), String(earliestYear));
      const yearList = await yearEntry.getAttribute("list");
      const years = await page
        .locator(`datalist[id="${yearList}"] option`)
        .evaluateAll((options) =>
          options.map((option) => Number(option.value)),
        );
      assert.deepEqual(
        years,
        Array.from(
          { length: Number(patientToday().slice(0, 4)) - earliestYear + 1 },
          (_, index) => Number(patientToday().slice(0, 4)) - index,
        ),
      );
      assert.equal(
        await calendar
          .getByRole("button", { name: "Previous month" })
          .isDisabled(),
        true,
      );
      await yearEntry.fill(tooOldYear);
      await yearEntry.press("Enter");
      assert.equal(await yearEntry.getAttribute("aria-invalid"), "true");
      await yearEntry.fill(String(earliestYear));
      await yearEntry.press("Enter");
      assert.equal(await yearEntry.getAttribute("aria-invalid"), "false");
      await calendar
        .getByRole("button", { name: "Cancel", exact: true })
        .click();
      await birthDate.fill(eighteenth);
      await page
        .getByRole("button", {
          name: "Open calendar: Date of birth",
          exact: true,
        })
        .click();
      await page
        .getByRole("button", { name: eighteenth, exact: true })
        .waitFor();
      assert.equal(
        await page
          .getByRole("button", { name: eighteenth, exact: true })
          .isDisabled(),
        true,
      );
      await page.screenshot({
        path: resolve(artifact, "evidence", "child-calendar.png"),
        animations: "disabled",
      });
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await submitSignup.click();
      await page
        .getByText("The patient must be under 18.", { exact: true })
        .waitFor();
      await birthDate.fill(younger);
      await page
        .getByRole("button", {
          name: "Open calendar: Date of birth",
          exact: true,
        })
        .click();
      const eligible = page.getByRole("button", { name: younger, exact: true });
      await eligible.click();
      assert.equal(await birthDate.inputValue(), younger);
      await capture("signup");
      await page
        .getByRole("combobox", { name: "Page language" })
        .selectOption("ar");
      assert.equal(
        await page.locator('.request-shell[lang="ar"][dir="rtl"]').count(),
        1,
      );
      await capture("signup-ar");
      assert.equal(
        await page.getByRole("button", { name: "متابعة", exact: true }).count(),
        1,
      );
      await page
        .getByRole("combobox", { name: "لغة الصفحة" })
        .selectOption("en");
      await submitSignup.click();
      await page
        .getByText("If this address is eligible", { exact: false })
        .waitFor();
      assert.equal(mailbox.at(-1).to, "browser@example.invalid");
      assert.equal(
        await db
          .collection("patient_accounts")
          .findOne({ email: "browser@example.invalid" }),
        null,
      );
      await capture("sign-in-notice");
      await page.goto(origin + "/__review/mail");
      await page
        .getByRole("listitem")
        .filter({ hasText: "browser@example.invalid" })
        .getByRole("link")
        .click();
      const suggestion = page
        .getByRole("button", { name: /^lea\.demo(?:-[a-f0-9]{4})?$/ })
        .first();
      await suggestion.waitFor();
      assert.equal(await suggestion.innerText(), "lea.demo");
      await capture("activation");
      await page
        .getByRole("combobox", { name: "Page language" })
        .selectOption("ar");
      await capture("activation-ar");
      await page
        .getByRole("combobox", { name: "لغة الصفحة" })
        .selectOption("en");
      await page
        .getByLabel("Username", { exact: false })
        .fill("REVIEW.PATIENT");
      await page.getByLabel("New password", { exact: false }).fill(p1);
      await page
        .getByRole("button", { name: "Activate account", exact: true })
        .click();
      await page
        .getByRole("alert")
        .filter({ hasText: "That username is taken" })
        .waitFor();
      const priorChoice = await suggestion.innerText();
      await page.getByRole("button", { name: "New suggestions" }).click();
      await page
        .getByRole("button", { name: priorChoice, exact: true })
        .waitFor({ state: "detached" });
      const savedName = await suggestion.innerText();
      await suggestion.click();
      await page
        .getByRole("button", { name: "Activate account", exact: true })
        .click();
      await page
        .getByText("Your email is verified. You can sign in.")
        .waitFor();
      const activated = await db
        .collection("patient_accounts")
        .findOne({ email: "browser@example.invalid" });
      assert.equal(activated.pendingPhone, "+96171123456");
      assert.equal(activated.profiles.length, 1);
      const { id, ...savedProfile } = activated.profiles[0];
      assert.ok(id);
      assert.deepEqual(savedProfile, {
        ...patient,
        phone: "+96171123456",
        dateOfBirth: younger,
        relationship: "child",
      });
      assert.equal(new URL(page.url()).hash, "");
      await page
        .getByLabel("Email, username, or verified phone")
        .fill("browser@example.invalid");
      await page.getByLabel(/^Password/).fill("incorrect");
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await page
        .getByRole("alert")
        .filter({ hasText: "Check your sign-in details" })
        .waitFor();
      await page.getByLabel(/^Password/).fill(p1);
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await page
        .getByRole("heading", { name: "My account", exact: true })
        .waitFor();
      await page.reload();
      await page
        .getByRole("heading", { name: "My account", exact: true })
        .waitFor();
      await page.screenshot({
        path: resolve(artifact, "evidence/my-account-desktop.png"),
      });
      await page.getByRole("button", { name: "Sign out", exact: true }).click();
      await page
        .getByLabel("Email, username, or verified phone")
        .fill(savedName);
      await page.getByLabel(/^Password/).fill(p1);
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await page
        .getByRole("heading", { name: "My account", exact: true })
        .waitFor();
      await page.setViewportSize({ width: 390, height: 844 });
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page
        .getByRole("combobox", { name: "Page language" })
        .selectOption("ar");
      assert.equal(
        await page.locator('.request-shell[lang="ar"][dir="rtl"]').count(),
        1,
      );
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      );
      await page.screenshot({
        path: resolve(artifact, "evidence/my-account-mobile-ar.png"),
      });
      await page
        .getByRole("combobox", { name: "لغة الصفحة" })
        .selectOption("en");
      await call("recover", { email: "browser@example.invalid" });
      await page.goto(mailbox.at(-1).link);
      await page.getByLabel("New password", { exact: false }).fill(p2);
      await page
        .getByRole("button", { name: "Set a new password", exact: true })
        .click();
      await page
        .getByText("Password updated. Sign in with your new password.")
        .waitFor();
      await page
        .getByRole("heading", { name: "Sign in", exact: true })
        .waitFor();
      await page
        .getByRole("combobox", { name: "Page language" })
        .selectOption("ar");
      await page
        .getByRole("button", { name: "تسجيل الدخول", exact: true })
        .waitFor();
      await verifyTypography();
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      );
      await page.screenshot({
        path: resolve(artifact, "evidence/sign-in-mobile-ar.png"),
      });
      await page.goto(origin + "/doctors");
      await page.locator(".directory-filters label").first().waitFor();
      for (const width of [390, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        const colors = await page
          .locator(".directory-filters label")
          .evaluateAll((labels) =>
            labels.map((label) => getComputedStyle(label).color),
          );
        assert.deepEqual(colors, ["rgb(34, 107, 157)", "rgb(34, 107, 157)"]);
      }
      console.log(
        "PASS Cedar shell, browser activation and sign-in, reload session, focus, mobile Arabic RTL and reduced-motion viewport",
      );
    } finally {
      await browser.close();
    }
  } else {
    const verified = await seedAccount("review.verified", "+96171123456", true);
    const pending = await seedAccount("review.pending", "+96170123456", false);
    if (verifyClinicalBoundary) {
      const { verifyPatientClinicalBoundary } =
        await import("./patient-clinical-boundary-review.mjs");
      await verifyPatientClinicalBoundary({
        origin,
        credential,
        requestKey,
        pending,
        callAccount,
        selection,
        accounts: db.collection("patient_accounts"),
      });
    } else if (
      process.argv.includes("--verify-phone") ||
      process.argv.includes("--phone-review")
    ) {
      const { createSecurityFixture } =
        await import("../../staff-api/test/helpers/security-fixture.js");
      const { createRequestTransport } =
        await import("../../staff-api/src/request-integration.js");
      const { seedPublicationAuthority, signInSynthetic } =
        await import("../../staff-api/test/helpers/publication-authority.js");
      const requestIntegration = {
        mode: "test",
        target: origin + "/api/requests/integration",
        credential,
        key: randomBytes(32),
        publicBase: origin,
        contact: "Cedar TEST",
      };
      requestIntegration.transport = createRequestTransport(requestIntegration);
      staffFixture = await createSecurityFixture({
        reviewPort: 4101,
        collectionPrefix: `patient_phone_review_${randomUUID().replaceAll("-", "")}_`,
        requestIntegration,
      });
      await staffFixture.reset();
      await seedPublicationAuthority(staffFixture);
      const receptionist = await signInSynthetic(staffFixture, [
        "Receptionist",
      ]);
      const staffCall = (body, token = receptionist.token) =>
        staffFixture.request("/website-requests/phoneVerification", {
          method: "POST",
          token,
          body,
        });
      assert.equal((await staffCall({ action: "list" })).status, 403);
      await staffFixture.db.collection("operational_grants").insertOne({
        _id: receptionist.id,
        id: receptionist.id,
        revision: 1,
        scopeIds: ["clinic:synthetic"],
      });
      const { _electron } = await import("playwright");
      const packageOption = process.argv.indexOf("--package");
      const executablePath =
        packageOption < 0
          ? undefined
          : resolve(process.argv[packageOption + 1]);
      desktop = await _electron.launch({
        executablePath,
        args: [
          ...(executablePath ? [] : [resolve(artifact, "staff-app")]),
          "--demo-loopback",
          `--user-data-dir=${resolve(artifact, "electron-profile")}`,
        ],
        env: { ...process.env, STAFF_API_URL: staffFixture.origin },
      });
      await desktop.evaluate(({ shell }) => {
        globalThis.phoneReviewDraft = null;
        shell.openExternal = async (url) => {
          const draft = new URL(url);
          if (draft.origin !== "https://wa.me")
            throw Error("Unexpected external destination");
          globalThis.phoneReviewDraft = draft.searchParams.get("text");
        };
      });
      const staff = await desktop.firstWindow();
      await staff
        .getByLabel("Username", { exact: true })
        .fill(receptionist.username);
      await staff
        .getByLabel("Password or passphrase", { exact: true })
        .fill(receptionist.password);
      await staff.getByRole("button", { name: "Sign in", exact: true }).click();
      await staff.getByRole("button", { name: /Website requests/i }).click();
      await staff.getByRole("button", { name: /Phone verification/i }).click();
      if (process.argv.includes("--phone-review")) {
        console.log(
          `Patient review: ${origin}/account?view=verify-phone\nAccount: ${pending.email}\nFictional password: ${reviewPassword}\nWhatsApp opens only a synthetic capture. Press D then Enter to display the captured fictional draft. Press Enter to close.`,
        );
        const input = createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        try {
          while ((await input.question("")).trim().toLowerCase() === "d")
            console.log(
              (await desktop.evaluate(() => globalThis.phoneReviewDraft)) ??
                "No draft opened yet.",
            );
        } finally {
          input.close();
        }
      } else {
        const opts = { cookie: pending.cookie };
        await callAccount(
          "phone-request",
          { personal: true, language: "en" },
          opts,
        );
        const duplicate = await callAccount(
          "phone-request",
          { personal: true, language: "en" },
          opts,
        );
        assert.equal(duplicate.result.state, "queued");
        const integrationUrl = origin + "/api/requests/integration/phone";
        const unauthorized = await fetch(integrationUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: '{"action":"list"}',
        });
        assert.equal(unauthorized.status, 401);
        assert.equal((await staffCall({ action: "list" })).body.count, 1);
        await staff
          .getByRole("button", { name: /Phone verification/i })
          .click();
        await staff
          .getByRole("button", { name: "Open WhatsApp", exact: true })
          .click();
        await staff
          .getByText("Draft opened", { exact: false })
          .first()
          .waitFor();
        assert.equal((await staffCall({ action: "list" })).body.count, 1);
        const draft = await desktop.evaluate(() => globalThis.phoneReviewDraft);
        const code = draft.match(/\b\d{6}\b/)[0];
        const link = draft.match(/http[^\s]+/)[0];
        assert.equal(new URL(link).searchParams.get("view"), "verify-phone");
        assert.ok(!link.includes(code));
        await staff
          .getByRole("button", { name: "Mark sent", exact: true })
          .click();
        await staff
          .getByText("Awaiting code entry", { exact: false })
          .waitFor();
        assert.equal((await staffCall({ action: "list" })).body.count, 0);
        const evidence = resolve(artifact, "evidence");
        await mkdir(evidence, { recursive: true });
        await staff.screenshot({
          path: resolve(evidence, "staff-phone-queue.png"),
        });
        const { chromium } = await import("playwright");
        const browser = await chromium.launch({ channel: "msedge" });
        try {
          const page = await browser.newPage({
            viewport: { width: 390, height: 844 },
          });
          await page.goto(link);
          await page
            .getByLabel("Email, username, or verified phone")
            .fill(pending.email);
          await page.getByLabel(/^Password/).fill(reviewPassword);
          await page
            .getByRole("button", { name: "Sign in", exact: true })
            .click();
          await page
            .getByRole("heading", { name: "Verify phone", exact: true })
            .waitFor();
          await page.getByLabel("WhatsApp code").waitFor();
          await page.screenshot({
            path: resolve(evidence, "patient-code-mobile.png"),
          });
          await page.setViewportSize({ width: 1440, height: 1000 });
          await page.screenshot({
            path: resolve(evidence, "patient-code-desktop.png"),
          });
          await page
            .getByLabel("WhatsApp code")
            .fill(code === "000000" ? "000001" : "000000");
          await page
            .getByRole("button", { name: "Verify code", exact: true })
            .click();
          await page
            .getByText("Enter the correct six-digit code.", { exact: true })
            .waitFor();
          await page.getByLabel("WhatsApp code").fill(code);
          await page
            .getByRole("button", { name: "Verify code", exact: true })
            .click();
          await page
            .getByText("WhatsApp number verified. You can request a booking.", {
              exact: true,
            })
            .waitFor();
        } finally {
          await browser.close();
        }
        await callAccount("phone-verify", { code }, { ...opts, status: 409 });
        await callAccount("signin", {
          identifier: "+96170123456",
          password: reviewPassword,
        });
        const secondOwner = await seedAccount(
          "review.shared",
          "+96170123456",
          false,
        );
        await callAccount(
          "phone-request",
          { personal: true, language: "en" },
          { cookie: secondOwner.cookie },
        );
        const shared = (await staffCall({ action: "list" })).body.rows.find(
          (row) => row.account === "review.shared",
        );
        const sharedDraft = (
          await staffCall({ action: "prepare", id: shared.id })
        ).body;
        const sharedCode = sharedDraft.message.match(/\b\d{6}\b/)[0];
        await staffCall({ action: "opened", id: shared.id });
        const sharedResult = await callAccount(
          "phone-verify",
          { code: sharedCode },
          { cookie: secondOwner.cookie },
        );
        assert.equal(sharedResult.result.account.bookingPhone, "+96170123456");
        assert.equal(sharedResult.result.account.verifiedPhone, null);
        await callAccount(
          "book",
          {
            profileId: sharedResult.result.account.profiles[0].id,
            selection,
            submissionKey: randomBytes(32).toString("base64url"),
            language: "en",
            honeypot: "",
          },
          { cookie: secondOwner.cookie },
        );
        const recovery = { phone: "+96170123456", language: "en" };
        await callAccount("phone-recover", recovery);
        const recoveryRow = (
          await staffCall({ action: "list" })
        ).body.rows.find((row) => row.recovery);
        const prepared = (
          await staffCall({ action: "prepare", id: recoveryRow.id })
        ).body;
        const recoveryCode = prepared.message.match(/\b\d{6}\b/)[0];
        await staffCall({ action: "opened", id: recoveryRow.id });
        offset += 16 * 60_000;
        await callAccount(
          "phone-reset",
          {
            phone: recovery.phone,
            code: recoveryCode,
            password: reviewPassword,
          },
          { status: 400 },
        );
        await callAccount("phone-recover", recovery);
        const fresh = (await staffCall({ action: "list" })).body.rows.find(
          (row) => row.recovery && row.state === "queued",
        );
        const preparedAgain = (
          await staffCall({ action: "prepare", id: fresh.id })
        ).body;
        const freshCode = preparedAgain.message.match(/\b\d{6}\b/)[0];
        await staffCall({ action: "opened", id: fresh.id });
        await staffCall({ action: "sent", id: fresh.id });
        await callAccount("phone-reset", {
          phone: recovery.phone,
          code: freshCode,
          password: reviewPassword,
        });
        await callAccount(
          "phone-reset",
          { phone: recovery.phone, code: freshCode, password: reviewPassword },
          { status: 400 },
        );
        await callAccount("phone-status", {}, { ...opts, status: 401 });
        console.log(
          "PASS real Cedar Staff queue, manual open/sent distinction, unauthorized scope, browser verification, single-use, expiry and WhatsApp recovery",
        );
      }
    } else if (process.argv.includes("--verify-gate")) {
      await callAccount(
        "book",
        {
          profileId: pending.result.account.profiles[0].id,
          selection,
          submissionKey: randomBytes(32).toString("base64url"),
          language: "en",
          honeypot: "",
        },
        { status: 403, cookie: pending.cookie },
      );
      const { chromium } = await import("playwright");
      const browser = await chromium.launch({ channel: "msedge" });
      try {
        const page = await browser.newPage();
        await page.goto(origin + "/account");
        await page
          .getByLabel("Email, username, or verified phone")
          .fill(pending.email);
        await page.getByLabel(/^Password/).fill(reviewPassword);
        await page
          .getByRole("button", { name: "Sign in", exact: true })
          .click();
        await page
          .getByRole("heading", { name: "My account", exact: true })
          .waitFor();
        const evidence = resolve(artifact, "evidence");
        await mkdir(evidence, { recursive: true });
        const verifyLink = page.getByRole("link", {
          name: "Verify phone",
          exact: true,
        });
        for (const [name, path] of [
          ["account", "/account"],
          ["home", "/"],
        ]) {
          await page.goto(origin + path);
          await verifyLink.waitFor();
          assert.ok(
            await verifyLink.evaluate((link) =>
              link.classList.contains("button-primary"),
            ),
          );
          for (const [device, width] of [
            ["desktop", 1440],
            ["mobile", 390],
          ]) {
            await page.setViewportSize({ width, height: 900 });
            const notice = page.locator(".phone-verification-notice");
            assert.ok(
              await notice.evaluate((element) => {
                const bounds = element.getBoundingClientRect();
                const header = document
                  .querySelector(".home-header")
                  .getBoundingClientRect();
                return (
                  bounds.left >= 0 &&
                  bounds.right <= innerWidth &&
                  bounds.top >= header.bottom
                );
              }),
            );
            if (name === "home" && device === "desktop") {
              assert.ok(
                await notice.evaluate(
                  (element) =>
                    element.getBoundingClientRect().left > innerWidth / 2,
                ),
              );
            }
            await page.screenshot({
              path: resolve(evidence, `${name}-verify-phone-${device}.png`),
            });
          }
          await page.keyboard.press("Tab");
          await verifyLink.focus();
          assert.ok(
            await verifyLink.evaluate(
              (link) =>
                link.matches(":focus-visible") &&
                parseFloat(getComputedStyle(link).outlineWidth) > 0,
            ),
          );
          await page.keyboard.press("Enter");
          await page
            .getByRole("heading", { name: "Verify phone", exact: true })
            .waitFor();
        }
        let catalogueCalls = 0;
        page.on("request", (request) => {
          if (request.url().startsWith(origin + "/api/requests/"))
            catalogueCalls++;
        });
        for (const navigate of [
          () => page.goto(origin + "/request"),
          () => page.reload(),
        ]) {
          const response = await navigate();
          console.log(
            `Direct /request document: HTTP ${response.status()} at ${page.url()}`,
          );
          assert.equal(response.status(), 200);
          assert.match(response.headers()["cache-control"], /no-store/);
          await page
            .getByRole("link", { name: "Verify phone", exact: true })
            .waitFor();
          assert.equal(
            await page.getByRole("heading", { name: "Page not found" }).count(),
            0,
          );
          assert.equal(
            await page
              .getByRole("combobox", { name: "Doctor or specialist" })
              .count(),
            0,
          );
        }
        assert.equal(catalogueCalls, 0);
        await page.screenshot({
          path: resolve(evidence, "direct-request-gate.png"),
        });
        await page
          .getByRole("button", {
            name: "Sign out and continue as guest",
            exact: true,
          })
          .click();
        await page.waitForURL(origin + "/request");
        const picker = page.getByRole("combobox", {
          name: "Doctor or specialist",
        });
        await picker.fill(professional.name);
        await page.getByRole("option", { name: /Dr\. Cedar Review/ }).click();
        await page
          .locator(".request-session-option")
          .filter({ hasText: "09:00" })
          .click();
        await page.getByRole("button", { name: /^Continue/ }).click();
        await page.getByLabel("First name", { exact: true }).waitFor();
        const session = await page.request.get(
          origin + "/api/patient-account/session",
        );
        assert.equal((await session.json()).account, null);
        console.log(
          "PASS direct /request and reload show the verification gate",
        );
        console.log(
          "PASS actionable notices on / and /account, server phone gate, and sign out into usable guest form",
        );
      } finally {
        await browser.close();
      }
    } else if (process.argv.includes("--verify-booking")) {
      const profileId = verified.result.account.profiles[0].id;
      const pendingId = pending.result.account.profiles[0].id;
      const key = () => randomBytes(32).toString("base64url");
      const input = {
        profileId,
        selection,
        submissionKey: key(),
        language: "en",
        honeypot: "",
      };
      const options = { cookie: verified.cookie };
      await callAccount("book", input, { status: 401 });
      await callAccount(
        "book",
        { ...input, profileId: pendingId },
        { ...options, status: 404 },
      );
      await callAccount(
        "profile-requests",
        { profileId: pendingId },
        { ...options, status: 404 },
      );
      await callAccount(
        "book",
        { ...input, profileId: pendingId },
        { cookie: pending.cookie, status: 403 },
      );
      await callAccount(
        "book",
        { ...input, patient: reviewPatient },
        { ...options, status: 400 },
      );
      assert.equal(await db.collection("website_requests").countDocuments(), 0);
      const profiles = [
        {
          relationship: "self",
          patient: {
            ...reviewPatient,
            firstName: "Rana",
            dateOfBirth: "1990-01-02",
          },
        },
        {
          relationship: "child",
          patient: { ...reviewPatient, firstName: "Nour" },
        },
      ];
      const added = await callAccount("add-profiles", { profiles }, options);
      assert.equal(added.result.account.profiles.length, 3);
      const secondId = added.result.account.profiles.find(
        (p) => p.firstName === "Nour",
      ).id;
      await callAccount(
        "add-profiles",
        { profiles: profiles.slice(0, 1) },
        { ...options, status: 409 },
      );
      const first = (await callAccount("book", input, options)).result;
      assert.equal(
        (await callAccount("book", input, options)).result.reference,
        first.reference,
      );
      await callAccount(
        "book",
        { ...input, profileId: secondId },
        { ...options, status: 409 },
      );
      const second = (
        await callAccount(
          "book",
          { ...input, profileId: secondId, submissionKey: key() },
          options,
        )
      ).result;
      const requests = async (id) =>
        (await callAccount("profile-requests", { profileId: id }, options))
          .result.requests;
      assert.deepEqual(
        (await requests(profileId)).map((request) => request.reference),
        [first.reference],
      );
      assert.deepEqual(
        (await requests(secondId)).map((request) => request.reference),
        [second.reference],
      );
      const stored = await db
        .collection("website_requests")
        .findOne({ reference: second.reference });
      assert.equal(stored.patient.firstName, "Nour");
      assert.equal(stored.patient.phone, "+96171123456");
      assert.equal(stored.owner.profileId, secondId);
      const guest = (
        await reviewCall("requests/submit", {
          selection,
          submissionKey: key(),
          honeypot: "",
          patient: {
            ...reviewPatient,
            phone: "+96176123456",
            preferredLanguage: "en",
          },
        })
      ).result;
      assert.equal(
        (
          await db
            .collection("website_requests")
            .findOne({ reference: guest.reference })
        ).owner,
        undefined,
      );
      assert.equal(
        (await reviewCall("requests/track", { token: guest.trackingToken }))
          .result.reference,
        guest.reference,
      );
      const pulled = await intake.pull();
      assert.equal(pulled.requests.length, 3);
      assert.ok(
        pulled.requests.every((request) => !Object.hasOwn(request, "owner")),
      );
      console.log(
        "PASS phone gate, ownership, Both and two children, retry scope, isolated per-profile history, guest tracking and staff intake",
      );

      const { chromium } = await import("playwright");
      const browser = await chromium.launch({ channel: "msedge" });
      try {
        const evidence = resolve(artifact, "evidence");
        await mkdir(evidence, { recursive: true });
        const page = await browser.newPage({
          viewport: { width: 1440, height: 1000 },
        });
        const signIn = async (email) => {
          await page.goto(origin + "/account");
          await page
            .getByLabel("Email, username, or verified phone")
            .fill(email);
          await page.getByLabel(/^Password/).fill(reviewPassword);
          await page
            .getByRole("button", { name: "Sign in", exact: true })
            .click();
          await page
            .getByRole("heading", { name: "My account", exact: true })
            .waitFor();
        };
        await signIn(pending.email);
        await page.goto(origin + "/");
        await page
          .getByRole("link", { name: "Verify phone", exact: true })
          .click();
        await page
          .getByText("The center is closed now.", { exact: false })
          .waitFor();
        hoursKnown = false;
        const unknownHours = page.waitForResponse((response) =>
          response.url().endsWith("/api/schedule"),
        );
        await page.reload();
        assert.equal(
          (await (await unknownHours).json()).publicationStatus,
          "unpublished",
        );
        await page
          .getByRole("heading", { name: "Verify phone", exact: true })
          .waitFor();
        assert.equal(
          await page
            .getByText("The center is closed now.", { exact: false })
            .count(),
          0,
        );
        hoursKnown = true;
        await page
          .getByRole("button", { name: "Sign out and continue as guest" })
          .click();
        await page
          .getByRole("heading", {
            name: "Request a clinic session",
            exact: true,
          })
          .waitFor();
        await page.goto(origin + "/track#" + guest.trackingToken);
        await page
          .getByText(
            "Reception will review the request during opening hours.",
            { exact: false },
          )
          .waitFor();
        await signIn(verified.email);
        await page
          .getByRole("button", { name: "Add profile", exact: true })
          .click();
        await page.getByLabel("First name", { exact: true }).fill("Lina");
        await page.getByLabel("Father’s name").fill(reviewPatient.fatherName);
        await page.getByLabel("Last name").fill(reviewPatient.lastName);
        await page
          .getByLabel("Mother’s maiden name")
          .fill(reviewPatient.motherFirstName);
        await page
          .getByLabel("Date of birth", { exact: true })
          .fill(reviewPatient.dateOfBirth);
        await page
          .getByLabel("Gender", { exact: true })
          .selectOption(reviewPatient.gender);
        await page
          .getByRole("button", { name: "Save profiles", exact: true })
          .click();
        await page.getByRole("heading", { name: "Lina Demo" }).waitFor();
        const lea = page
          .getByRole("heading", { name: "Lea Demo" })
          .locator("..");
        await lea.getByRole("button", { name: "View requests" }).click();
        await lea.getByText(first.reference, { exact: true }).waitFor();
        await page.evaluate(() => {
          document.activeElement?.blur();
          window.scrollTo({ top: 0, behavior: "instant" });
        });
        await page.screenshot({
          path: resolve(evidence, "profiles-desktop.png"),
          fullPage: true,
        });
        await page.setViewportSize({ width: 390, height: 844 });
        await page.evaluate(() =>
          window.scrollTo({ top: 0, behavior: "instant" }),
        );
        await page.screenshot({
          path: resolve(evidence, "profiles-mobile.png"),
          fullPage: true,
        });
        await lea.getByRole("link", { name: "Request a session" }).click();
        await page
          .getByRole("combobox", { name: "Doctor or specialist" })
          .fill(professional.name);
        await page.getByRole("option", { name: /Dr\. Cedar Review/ }).click();
        await page
          .locator(".request-session-option")
          .filter({ hasText: "09:00" })
          .click();
        await page.getByRole("button", { name: /^Continue/ }).click();
        await page.getByText("Lea Demo", { exact: true }).waitFor();
        await page.getByRole("button", { name: /^Continue/ }).click();
        await page.getByRole("button", { name: /^Submit request/ }).click();
        await page
          .getByRole("heading", { name: "Request received", exact: true })
          .waitFor();
        await page.screenshot({
          path: resolve(evidence, "signed-request-mobile.png"),
          fullPage: true,
        });
      } finally {
        await browser.close();
      }
      await callAccount("delete", { password: reviewPassword }, options);
      await callAccount(
        "profile-requests",
        { profileId },
        { ...options, status: 401 },
      );
      assert.equal(
        (await reviewCall("requests/track", { token: first.trackingToken }))
          .result.reference,
        first.reference,
      );
      console.log(
        "PASS isolated browser profile history, signed-in booking, closed notices, guest fallback and deletion preserving tracking",
      );
    } else {
      console.log(
        `Account review: ${origin}/account\nSynthetic inbox: ${origin}/__review/mail\nReview session date: ${date}\nAccounts: ${verified.email} and ${pending.email}\nFictional password: ${reviewPassword}\nPress Enter to stop and clear this review's fixtures.`,
      );
      const input = createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      try {
        await input.question("");
      } finally {
        input.close();
      }
    }
  }
} finally {
  try {
    try {
      await desktop?.close();
    } finally {
      await staffFixture?.close();
    }
  } finally {
    if (server?.listening) await new Promise((done) => server.close(done));
    try {
      for (const name of names)
        await db
          .collection(name)
          .drop()
          .catch((error) => {
            if (error.code !== 26) throw error;
          });
    } finally {
      await connection.client.close();
    }
  }
}
