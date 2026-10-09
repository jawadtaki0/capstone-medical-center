import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createApp } from "../src/app.js";
import {
  AUTH_COLLECTIONS,
  AUTH_POLICY,
  AUTH_THROTTLE_POLICIES,
  createAuthService,
  digestSecret,
} from "../src/auth.js";
import { StaffError, publicError } from "../src/errors.js";
import {
  ROLES,
  hasPermission,
  permissionsFor,
  requiresMfa,
  validRoles,
} from "../src/permissions.js";
import {
  normalizeUsername,
  validatePassword,
  validateProfile,
  validDate,
} from "../src/validation.js";

const profile = () => ({
  firstName: "Synthetic",
  lastName: "Administrator",
  fatherName: "Example",
  motherName: "Sample",
  dateOfBirth: "1990-03-12",
  address: "Synthetic testing address",
  phone: "+96171123456",
  email: "synthetic@example.test",
  departments: ["Administration"],
  employmentStartDate: "2026-10-02",
  qualification: {
    type: "university",
    title: "Synthetic management degree",
    institution: "Testing University",
  },
});

test("usernames normalize consistently without treating an admin name as a role", () => {
  assert.equal(normalizeUsername("  Synthetic.Admin  "), "synthetic.admin");
  assert.equal(normalizeUsername("admin"), "admin");
  for (const value of [
    "ab",
    "staff admin",
    "admin@example.test",
    "x".repeat(41),
    null,
  ])
    assert.throws(() => normalizeUsername(value), StaffError);
  assert.equal(
    hasPermission(["Clinic Receptionist"], "accounts:create"),
    false,
  );
});

test("passphrases preserve Unicode and whitespace while enforcing length and offline blocklist", () => {
  const value = "  a memorable synthetic phrase 🌲  ";
  assert.equal(validatePassword(value), value);
  assert.equal(validatePassword("🌲".repeat(15)), "🌲".repeat(15));
  assert.equal(validatePassword("x".repeat(128)), "x".repeat(128));
  for (const password of [
    "short",
    "🌲".repeat(14),
    "x".repeat(129),
    "passwordpassword",
    "Cedar Medical Center",
  ]) {
    assert.throws(() => validatePassword(password), StaffError);
  }
});

test("bundled licensed common-password data is checked offline against complete passwords", () => {
  const entries = readFileSync(
    new URL("../src/data/common-passwords.txt", import.meta.url),
    "utf8",
  )
    .trimEnd()
    .split("\n");
  assert.ok(
    entries.length > 10000,
    "The reviewed substantial dictionary must be bundled with the authority.",
  );
  const samples = entries
    .filter((entry) => /^[a-z0-9]{15,40}$/.test(entry))
    .slice(0, 100);
  assert.equal(samples.length, 100);
  for (const sample of samples)
    assert.throws(() => validatePassword(sample), StaffError);
  const sample = samples.find((value) => value.length <= 25);
  const longerPhrase = `A quiet forest surrounds ${sample} beneath stars`;
  assert.equal(
    validatePassword(longerPhrase),
    longerPhrase,
    "A matching substring is not a whole-password match.",
  );
  assert.match(
    readFileSync(new URL("../src/data/LICENSE", import.meta.url), "utf8"),
    /Copyright \(c\) 2018 Daniel Miessler/,
  );
  for (const padded of [
    "      password      ",
    "      123456      ",
    "               ",
  ]) {
    assert.throws(
      () => validatePassword(padded),
      StaffError,
      "Padding a short common password must not bypass the dictionary.",
    );
  }
});

test("predictable username and center passwords are blocked without substring bans or password modification", () => {
  const context = { username: "synthetic.admin" };
  for (const value of [
    "synthetic.admin123",
    "syntheticadmin123",
    "synthetic.admin!",
    "2026syntheticadmin",
    "syntheticadminsyntheticadmin",
    "Cedar medical center 2026!",
    "CEDAR-STAFF-ADMIN!",
  ]) {
    assert.throws(() => validatePassword(value, context), StaffError);
  }
  for (const value of [
    "  synthetic.admin gathers quiet stars  ",
    "A calm cedar medical center sunrise 🌲",
    "synthetic administrator explores forests!",
  ])
    assert.equal(validatePassword(value, context), value);
  assert.equal(
    validatePassword("synthetic.admin123", { username: "different.account" }),
    "synthetic.admin123",
  );
});

test("complete first-Admin profile is allowlisted with unverified individual recovery email", () => {
  const input = {
    ...profile(),
    roles: ["Admin"],
    password: "never copied",
    jobTitle: "not a field",
    identityCopy: "not accepted",
  };
  const value = validateProfile(input, "2026-10-02");
  assert.equal(value.emailVerified, false);
  assert.deepEqual(value.departments, ["Administration"]);
  assert.equal(value.fatherName, "Example");
  assert.equal(value.motherName, "Sample");
  assert.equal(Object.hasOwn(value, "roles"), false);
  assert.equal(Object.hasOwn(value, "password"), false);
  assert.equal(Object.hasOwn(value, "jobTitle"), false);
  assert.equal(Object.hasOwn(value, "identityCopy"), false);
  const variants = [
    { ...profile(), dateOfBirth: "2026-02-30" },
    { ...profile(), dateOfBirth: "2026-10-03" },
    { ...profile(), departments: ["Clinic", "Clinic"] },
    { ...profile(), departments: ["Unknown"] },
    { ...profile(), motherName: "" },
    { ...profile(), email: "not an email" },
    {
      ...profile(),
      qualification: {
        type: "baccalaureate",
        title: "General",
        institution: "Synthetic school",
      },
    },
  ];
  for (const variant of variants)
    assert.throws(() => validateProfile(variant, "2026-10-02"), StaffError);
  assert.equal(validDate("2024-02-29"), true);
  assert.equal(validDate("2026-02-29"), false);
});

test("six explicit roles grant own-profile access and only managers gain staff management", () => {
  for (const role of ROLES) {
    assert.equal(validRoles([role]), true);
    assert.ok(permissionsFor([role]).includes("workspace:view"));
    assert.ok(permissionsFor([role]).includes("profile:own:view"));
    assert.equal(
      hasPermission([role], "staff:directory"),
      ["Admin", "System Admin"].includes(role),
    );
    assert.equal(
      hasPermission([role], "staff:protected:manage"),
      role === "Admin",
    );
    assert.equal(hasPermission([role], "bookings:create"), false);
    assert.equal(hasPermission([role], "laboratory:release"), false);
  }
  assert.deepEqual(
    ROLES.filter((role) => requiresMfa([role])),
    ["Admin", "System Admin", "Clinic Admin", "Lab Admin"],
  );
  assert.equal(requiresMfa(["Clinic Receptionist", "Clinic Admin"]), true);
  for (const roles of [
    [],
    ["Admin", "Admin"],
    ["Unknown"],
    ["Admin", "Unknown"],
    null,
  ]) {
    assert.equal(validRoles(roles), false);
    assert.deepEqual(permissionsFor(roles), []);
  }
});

test("policy and digests encode server expiry and one-use challenge invariants", () => {
  assert.equal(AUTH_POLICY.idleMs, 600000);
  assert.equal(AUTH_POLICY.absoluteMs, 28800000);
  assert.equal(AUTH_POLICY.challengeMs, 300000);
  assert.equal(AUTH_POLICY.enrollmentMs, 600000);
  assert.equal(AUTH_POLICY.maxFailures, 5);
  assert.deepEqual(AUTH_THROTTLE_POLICIES.account, {
    maxFailures: 5,
    windowMs: 900000,
    cooldownMs: 900000,
  });
  assert.deepEqual(AUTH_THROTTLE_POLICIES.source, {
    maxFailures: 30,
    windowMs: 900000,
    cooldownMs: 900000,
  });
  assert.equal(Object.isFrozen(AUTH_THROTTLE_POLICIES), true);
  assert.equal(Object.isFrozen(AUTH_THROTTLE_POLICIES.account), true);
  assert.equal(Object.isFrozen(AUTH_THROTTLE_POLICIES.source), true);
  assert.equal(digestSecret("synthetic token").length, 64);
  assert.notEqual(digestSecret("synthetic token"), "synthetic token");
  for (const collection of [
    "installation_state",
    "accounts",
    "staff_profiles",
    "auth_challenges",
    "staff_sessions",
    "auth_throttles",
    "security_events",
    "account_setup_codes",
    "staff_management_state",
  ])
    assert.ok(Object.values(AUTH_COLLECTIONS).includes(collection));
  assert.throws(
    () => createAuthService({ db: {}, client: {}, vault: {} }),
    StaffError,
  );
});

test("unexpected driver/key errors never expose details to the client", () => {
  const result = publicError(
    new Error("synthetic connection credential and private factor"),
  );
  assert.equal(result.status, 503);
  assert.equal(result.body.error.code, "authority_unavailable");
  assert.equal(JSON.stringify(result).includes("credential"), false);
  assert.equal(JSON.stringify(result).includes("factor"), false);
});

async function response(
  context,
  path,
  { app, method = "GET", headers = {}, body } = {},
) {
  const server = (app ?? createApp({ demoMode: true })).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const result = await fetch(
    `http://127.0.0.1:${server.address().port}${path}`,
    { method, headers, ...(body !== undefined ? { body } : {}) },
  );
  return {
    status: result.status,
    headers: result.headers,
    body: await result.json(),
  };
}

test("unavailable local authority fails closed without granting a session", async (context) => {
  const result = await response(context, "/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "synthetic",
      password: "a synthetic passphrase",
    }),
  });
  assert.equal(result.status, 503);
  assert.equal(result.body.error.code, "authority_unavailable");
  assert.equal(Object.hasOwn(result.body, "token"), false);
  assert.equal(result.headers.get("cache-control"), "no-store");
});

test("untrusted browser origins and non-JSON mutations are rejected before authentication", async (context) => {
  const origin = await response(context, "/setup/claim", {
    method: "POST",
    headers: {
      Origin: "https://untrusted.example",
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  assert.equal(origin.status, 403);
  assert.equal(origin.body.error.code, "origin_denied");
  const form = await response(context, "/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "username=synthetic",
  });
  assert.equal(form.status, 415);
  assert.equal(form.body.error.code, "json_required");
  const insecure = await response(context, "/health", { app: createApp() });
  assert.equal(insecure.status, 403);
  assert.equal(insecure.body.error.code, "transport_denied");
});

test("health reports current authority reachability and only the agreed application origin is trusted", async (context) => {
  const db = {
    collection() {
      assert.fail("Health must not read accounts.");
    },
    async command(command) {
      assert.deepEqual(command, { ping: 1 });
    },
  };
  const app = createApp({
    db,
    client: { startSession() {} },
    vault: { encrypt() {}, decrypt() {} },
    demoMode: true,
  });
  const healthy = await response(context, "/health", {
    app,
    headers: { Origin: "app://staff" },
  });
  assert.equal(healthy.status, 200);
  assert.equal(healthy.body.status, "ok");
  assert.equal(healthy.body.database, "connected");
  const oldOrigin = await response(context, "/health", {
    app,
    headers: { Origin: "staff://app" },
  });
  assert.equal(oldOrigin.status, 403);
  const unavailableDb = {
    collection() {
      assert.fail("Health must not read accounts.");
    },
    async command() {
      throw new Error(
        "Synthetic unavailable database, private credentials never returned",
      );
    },
  };
  const outage = await response(context, "/health", {
    app: createApp({
      db: unavailableDb,
      client: { startSession() {} },
      vault: { encrypt() {}, decrypt() {} },
      demoMode: true,
    }),
  });
  assert.equal(outage.status, 503);
  assert.equal(outage.body.error.code, "authority_unavailable");
});

test("JSON parsing is bounded and errors are safe", async (context) => {
  const invalid = await response(context, "/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{invalid",
  });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error.code, "invalid_json");
  const oversized = await response(context, "/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ extra: "x".repeat(20000) }),
  });
  assert.equal(oversized.status, 413);
  assert.equal(oversized.body.error.code, "request_too_large");
});

// These service checks use local synthetic records, not a Mongo connection.
// Actual transaction/race behavior is covered by the isolated Mongo suite.
function localService(
  collection,
  clock = () => new Date("2040-10-02T08:00:00Z"),
) {
  const session = {
    async withTransaction(callback) {
      return callback();
    },
    async endSession() {},
  };
  return createAuthService({
    db: { collection },
    client: {
      startSession() {
        return session;
      },
    },
    vault: {
      encrypt() {
        throw new Error("No encryption expected in this read-only test.");
      },
      decrypt() {
        throw new Error("No decryption expected in this read-only test.");
      },
    },
    clock,
  });
}

test("first-Admin setup validates the passphrase with its normalized username before database writes", async () => {
  const service = localService(() =>
    assert.fail(
      "Invalid context-based passphrase must not reach the database.",
    ),
  );
  await assert.rejects(
    () =>
      service.claimSetup({
        username: "  Synthetic.Admin  ",
        password: "synthetic.admin123",
        code: "synthetic private setup code",
        profile: profile(),
      }),
    (error) => error instanceof StaffError && error.code === "invalid_input",
  );
});

test("bootstrap status uses only its durable marker and never reopens when the first account is removed", async () => {
  let marker;
  const service = localService((name) => {
    assert.equal(
      name,
      "installation_state",
      "Account count must not determine setup eligibility.",
    );
    return {
      async findOne(filter) {
        assert.deepEqual(filter, { _id: "first-admin" });
        return marker;
      },
    };
  });
  const issued = {
    _id: "first-admin",
    status: "issued",
    attempts: 0,
    expiresAt: new Date("2040-10-02T08:30:00Z"),
  };
  marker = issued;
  assert.deepEqual(await service.setupStatus(), { available: true });
  for (const status of ["claimed", "mfa_enrolled", "completed"]) {
    marker = {
      ...issued,
      status,
      firstAccountId: "account:removed-synthetic-admin",
    };
    assert.deepEqual(await service.setupStatus(), { available: false });
    assert.equal(marker.status, status);
    assert.equal(marker.firstAccountId, "account:removed-synthetic-admin");
  }
  for (const invalid of [
    null,
    { ...issued, attempts: 5 },
    { ...issued, attempts: undefined },
    { ...issued, attempts: -1 },
    { ...issued, attempts: Number.NaN },
    { ...issued, expiresAt: new Date("invalid") },
    { ...issued, expiresAt: new Date("2040-10-02T08:00:00Z") },
  ]) {
    marker = invalid;
    assert.deepEqual(await service.setupStatus(), { available: false });
  }
});

test("malformed persistent throttle metadata fails closed before password verification or writes", async () => {
  const baseline = {
    failures: 1,
    windowStartedAt: new Date("2040-10-02T07:59:00Z"),
    blockedUntil: null,
  };
  for (const record of [
    { ...baseline, failures: undefined },
    { ...baseline, failures: -1 },
    { ...baseline, failures: Number.NaN },
    { ...baseline, windowStartedAt: new Date("invalid") },
    { ...baseline, blockedUntil: undefined },
    { ...baseline, blockedUntil: new Date("invalid") },
  ]) {
    const service = localService((name) => {
      assert.equal(name, "auth_throttles");
      return {
        async findOne() {
          return record;
        },
      };
    });
    await assert.rejects(
      () =>
        service.login({
          username: "synthetic.admin",
          password: "synthetic passphrase only",
        }),
      (error) =>
        error instanceof StaffError && error.code === "authority_unavailable",
    );
  }
});

test("invalid or expired sessions are permanently revoked with one secret-free event, even after clock rewind", async () => {
  for (const variant of [
    "invalid-date",
    "idle-expiry",
    "absolute-expiry",
    "invalid-version",
  ]) {
    let at = new Date("2040-10-02T08:00:00Z");
    const token = `synthetic-local-token-${variant}`;
    const account = {
      _id: "account:synthetic-reception",
      username: "synthetic.reception",
      roles: ["Clinic Receptionist"],
      status: "active",
      version: variant === "invalid-version" ? 0 : 1,
    };
    const record = {
      _id: digestSecret(token),
      accountId: account._id,
      version: 1,
      revokedAt: null,
      lastActivityAt:
        variant === "invalid-date"
          ? new Date("invalid")
          : new Date("2040-10-02T07:50:00Z"),
      absoluteExpiresAt:
        variant === "absolute-expiry" ? at : new Date("2040-10-02T16:00:00Z"),
    };
    const events = [];
    const service = localService(
      (name) => {
        if (name === "staff_management_state")
          return {
            async updateOne(filter) {
              assert.deepEqual(filter, { _id: "staff-controls" });
              return { modifiedCount: 1 };
            },
          };
        if (name === "staff_sessions")
          return {
            async findOne() {
              return record;
            },
            async updateOne(filter, update) {
              assert.deepEqual(filter, { _id: record._id, revokedAt: null });
              Object.assign(record, update.$set);
              return { modifiedCount: 1 };
            },
          };
        if (name === "accounts")
          return {
            async findOne() {
              return account;
            },
          };
        if (name === "security_events")
          return {
            async insertOne(event) {
              events.push(event);
            },
          };
        assert.fail(`Unexpected collection access: ${name}`);
      },
      () => at,
    );
    await assert.rejects(
      () => service.readSession(token),
      (error) => error.code === "authentication_failed",
    );
    assert.ok(record.revokedAt instanceof Date);
    assert.equal(events.length, 1);
    assert.equal(events[0].action, "session_rejected");
    assert.equal(JSON.stringify(events).includes(token), false);
    at = new Date("2040-10-02T07:51:00Z");
    await assert.rejects(
      () => service.readSession(token),
      (error) => error.code === "authentication_failed",
    );
    assert.equal(
      events.length,
      1,
      "Subsequent polling must not recreate access or flood audit events.",
    );
  }
});
