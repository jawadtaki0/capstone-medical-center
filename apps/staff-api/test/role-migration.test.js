import { before, beforeEach, after, test } from "node:test";
import assert from "node:assert/strict";
import { createSecurityFixture } from "./helpers/security-fixture.js";
import {
  inspectRoleMigration,
  applyRoleMigration,
  planRoleMigration,
  ROLE_POLICY,
} from "../src/role-migration.js";
import { startIsolatedApiProcess } from "./helpers/isolated-api-process.js";
import { permissionsFor, validRoles, requiresMfa } from "../src/permissions.js";
import { assertRoleStoragePolicy } from "../src/db.js";

let f;
before(async () => {
  f = await createSecurityFixture();
});
beforeEach(async () => {
  await f.reset();
});
after(async () => {
  if (f) {
    await f.reset();
    await f.close();
  }
});
const inspect = (mappings) =>
  inspectRoleMigration({
    db: f.db,
    client: f.client,
    demoMode: true,
    mappings,
  });
const apply = (plan, extra = {}) =>
  applyRoleMigration({
    db: f.db,
    client: f.client,
    demoMode: true,
    plan,
    maintenanceAcknowledged: true,
    ...extra,
  });
async function seed() {
  const admin = await f.account({ roles: ["Admin"], mfa: true });
  const reception = await f.account({ roles: ["Clinic Receptionist"] });
  for (const [id, kind] of [
    ["clinic:one", "clinic"],
    ["service:one", "service"],
  ])
    await f.db
      .collection("operational_scopes")
      .insertOne({ _id: id, id, kind, active: true, revision: 1 });
  await f.db.collection("operational_grants").insertOne({
    _id: reception.id,
    id: reception.id,
    scopeIds: ["clinic:one", "service:one"],
    revision: 1,
  });
  return { admin, reception };
}
test("four roles use an explicit MFA set, deny removed/unknown/mixed invalid roles", () => {
  for (const role of ["Admin", "Clinic Admin", "Lab Admin", "Receptionist"]) {
    assert.equal(validRoles([role]), true);
    assert.equal(requiresMfa([role]), role !== "Receptionist");
    assert.equal(
      permissionsFor([role]).includes("staff:manage"),
      role === "Admin",
    );
  }
  assert.equal(requiresMfa(["Receptionist", "Lab Admin"]), true);
  for (const roles of [
    [],
    ["System Admin"],
    ["Clinic Receptionist"],
    ["Lab Receptionist"],
    ["Admin", "Unknown"],
    ["Admin", "Admin"],
  ]) {
    assert.equal(validRoles(roles), false);
    assert.deepEqual(permissionsFor(roles), []);
  }
});
test("dry-run detects formerly inert cross-kind grants; exact explicit mapping can preserve access", async () => {
  const { reception } = await seed();
  const unapproved = await inspect();
  assert.deepEqual(unapproved.problems[0].gains, ["service:one:view"]);
  await assert.rejects(apply(unapproved), /Unapproved/);
  const mappings = {
    [reception.id]: { roles: ["Receptionist"], scopeIds: ["clinic:one"] },
  };
  const plan = await inspect(mappings);
  assert.deepEqual(plan.problems, []);
  assert.equal((await apply(plan, { mappings })).status, "applied");
  assert.deepEqual(
    (await f.db.collection("operational_grants").findOne({ _id: reception.id }))
      .scopeIds,
    ["clinic:one"],
  );
});
test("System Admin is unresolved until explicit per-account mapping and effective losses approval", async () => {
  await seed();
  const person = await f.account({ roles: ["System Admin"], mfa: true });
  assert.ok(
    (await inspect()).problems.some(
      (p) => p.accountId === person.id && /explicitly approved/.test(p.reason),
    ),
  );
  const mappings = {
    [person.id]: {
      roles: ["Receptionist"],
      approvedChanges: {
        gains: [],
        losses: [
          "staff:directory",
          "staff:profiles",
          "staff:manage",
          "work:ordinary",
        ],
      },
    },
  };
  const plan = await inspect(mappings);
  const mapped = plan.changes.find((c) => c.accountId === person.id);
  assert.deepEqual(mapped.losses, [
    "staff:directory",
    "staff:manage",
    "staff:profiles",
    "work:ordinary",
  ]);
  assert.equal(mapped.mfaRequired, false);
  assert.equal(mapped.previouslyMfaRequired, true);
});
test("migration rollback, concurrency, rerun protection, factor preservation and old proof revocation use real transactions", async () => {
  const { admin, reception } = await seed();
  const login = await f.request("/auth/login", {
    method: "POST",
    body: { username: admin.username, password: admin.password },
  });
  const session = await f.request("/mfa/complete", {
    method: "POST",
    body: { challenge: login.body.challenge, code: await f.totp(admin.secret) },
  });
  assert.equal(session.status, 200);
  const before = await f.db.collection("accounts").findOne({ _id: admin.id });
  const mappings = {
      [reception.id]: { roles: ["Receptionist"], scopeIds: ["clinic:one"] },
    },
    plan = await inspect(mappings);
  await assert.rejects(
    apply(plan, {
      mappings,
      failBeforeCommit() {
        throw Error("Synthetic rollback");
      },
    }),
    /Synthetic rollback/,
  );
  assert.deepEqual(
    (await f.db.collection("accounts").findOne({ _id: reception.id })).roles,
    ["Clinic Receptionist"],
  );
  assert.equal(
    await f.db.collection("staff_role_migrations").countDocuments(),
    0,
  );
  const results = await Promise.all([
    apply(plan, { mappings }),
    apply(plan, { mappings }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [
    "already_applied",
    "applied",
  ]);
  assert.equal(
    (await f.request("/workspace", { token: session.body.token })).status,
    401,
  );
  const after = await f.db.collection("accounts").findOne({ _id: admin.id });
  assert.deepEqual(after.mfa, before.mfa);
  assert.equal(after.passwordHash, before.passwordHash);
  await f.db
    .collection("accounts")
    .updateOne(
      { _id: reception.id },
      { $set: { roles: ["Lab Admin"] }, $inc: { version: 1 } },
    );
  assert.equal((await apply(plan, { mappings })).status, "already_applied");
  assert.deepEqual(
    (await f.db.collection("accounts").findOne({ _id: reception.id })).roles,
    ["Lab Admin"],
  );
  const child = await startIsolatedApiProcess();
  try {
    assert.equal(
      (await child.request("/workspace", { token: session.body.token })).status,
      401,
    );
  } finally {
    await child.stop();
  }
});
test("stale grant/scope/account mappings, modified plans and absent maintenance acknowledgement refuse", async () => {
  const { reception } = await seed();
  const mappings = {
      [reception.id]: { roles: ["Receptionist"], scopeIds: ["clinic:one"] },
    },
    plan = await inspect(mappings);
  await assert.rejects(
    apply(plan, { mappings, maintenanceAcknowledged: false }),
    /maintenance/,
  );
  await assert.rejects(
    apply({ ...plan, policy: "changed" }, { mappings }),
    /modified/,
  );
  await f.db
    .collection("operational_scopes")
    .updateOne({ _id: "service:one" }, { $inc: { revision: 1 } });
  await assert.rejects(apply(plan, { mappings }), /changed/);
  assert.equal(
    await f.db.collection("staff_role_migrations").countDocuments(),
    0,
  );
});
test("zero/unknown roles, broken links and removal of the last eligible Admin refuse", async () => {
  const { admin, reception } = await seed();
  for (const roles of [[], ["Unknown"]])
    await assert.rejects(inspect({ [reception.id]: { roles } }), /Invalid/);
  const noAdmin = await inspect({ [admin.id]: { roles: ["Receptionist"] } });
  assert.ok(noAdmin.problems.some((p) => /No active/.test(p.reason)));
  await f.db
    .collection("accounts")
    .updateOne({ _id: reception.id }, { $set: { roles: ["Unknown"] } });
  await assert.rejects(inspect(), /Unknown/);
});

test("storage boundary refuses an unmigrated existing authority and changed policy invalidates protected requests", async () => {
  const { admin, reception } = await seed();
  const first = await f.request("/auth/login", {
    method: "POST",
    body: { username: admin.username, password: admin.password },
  });
  const login = await f.request("/mfa/complete", {
    method: "POST",
    body: { challenge: first.body.challenge, code: await f.totp(admin.secret) },
  });
  assert.equal(login.status, 200);
  await f.db
    .collection("staff_management_state")
    .updateOne({ _id: "staff-controls" }, { $unset: { rolePolicy: "" } });
  await assert.rejects(assertRoleStoragePolicy(f.db), /coordinated migration/);
  assert.equal(
    (await f.request("/workspace", { token: login.body.token })).status,
    503,
  );
  const mappings = {
      [reception.id]: { roles: ["Receptionist"], scopeIds: ["clinic:one"] },
    },
    plan = await inspect(mappings);
  assert.equal((await apply(plan, { mappings })).status, "applied");
  await assert.doesNotReject(assertRoleStoragePolicy(f.db));
  assert.equal(
    (await f.request("/workspace", { token: login.body.token })).status,
    401,
  );
});

test("approved MFA-role migration recomputes activation phase without resetting factors, passwords or pending acknowledgement", async () => {
  const { reception } = await seed();
  const pending = await f.account({
    roles: ["Clinic Admin"],
    status: "mfa_pending",
    mfa: false,
  });
  const promoted = await f.account({ roles: ["Receptionist"], mfa: false });
  const disabled = await f.account({
    roles: ["Receptionist"],
    status: "disabled",
    mfa: false,
  });
  const mappings = {
    [reception.id]: { roles: ["Receptionist"], scopeIds: ["clinic:one"] },
    [pending.id]: { roles: ["Receptionist"] },
    [promoted.id]: { roles: ["Clinic Admin"] },
    [disabled.id]: { roles: ["Clinic Admin"] },
  };
  // No grants: operational authority stays absent, but immediate workspace access
  // gained/lost through the activation gate still requires explicit approval.
  const unapproved = await inspect(mappings);
  assert.ok(
    unapproved.problems.some(
      (p) => p.accountId === pending.id && p.gains.includes("workspace:view"),
    ),
  );
  assert.ok(
    unapproved.problems.some(
      (p) => p.accountId === promoted.id && p.losses.includes("workspace:view"),
    ),
  );
  for (const problem of unapproved.problems) {
    if (problem.accountId && mappings[problem.accountId])
      mappings[problem.accountId].approvedChanges = {
        gains: problem.gains,
        losses: problem.losses,
      };
  }
  const raw = await f.db.collection("accounts").findOne({ _id: pending.id });
  const plan = await inspect(mappings);
  assert.deepEqual(plan.problems, []);
  assert.equal(
    plan.changes.find((c) => c.accountId === pending.id).status,
    "active",
  );
  assert.equal(
    plan.changes.find((c) => c.accountId === promoted.id).status,
    "mfa_pending",
  );
  assert.equal(
    plan.changes.find((c) => c.accountId === disabled.id).status,
    "disabled",
  );
  assert.equal((await apply(plan, { mappings })).status, "applied");
  const after = await f.db.collection("accounts").findOne({ _id: pending.id });
  assert.equal(after.passwordHash, raw.passwordHash);
  assert.deepEqual(after.mfa, raw.mfa);
  assert.ok(
    (
      await f.request("/auth/login", {
        method: "POST",
        body: { username: pending.username, password: pending.password },
      })
    ).body.token,
  );
  const login = await f.request("/auth/login", {
    method: "POST",
    body: { username: promoted.username, password: promoted.password },
  });
  assert.equal(login.body.kind, "enroll");
  assert.equal(
    (
      await f.request("/mfa/enroll", {
        method: "POST",
        body: { challenge: login.body.challenge },
      })
    ).status,
    200,
  );
});

test("empty but unmarked existing storage refuses startup instead of starting a broken authority", async () => {
  await f.db
    .collection("staff_management_state")
    .updateOne({ _id: "staff-controls" }, { $unset: { rolePolicy: "" } });
  await assert.rejects(assertRoleStoragePolicy(f.db), /unmarked/);
  assert.equal(await f.db.collection("accounts").countDocuments(), 0);
});

test("all administrative roles can refresh actual expired proof without acquiring staff or scope authority", async () => {
  for (const roles of [
    ["Admin"],
    ["Clinic Admin"],
    ["Lab Admin"],
    ["Clinic Admin", "Receptionist"],
    ["Lab Admin", "Clinic Admin"],
  ]) {
    const person = await f.account({ roles, mfa: true });
    const password = await f.request("/auth/login", {
      method: "POST",
      body: { username: person.username, password: person.password },
    });
    const signed = await f.request("/mfa/complete", {
      method: "POST",
      body: {
        challenge: password.body.challenge,
        code: await f.totp(person.secret),
      },
    });
    assert.equal(signed.status, 200);
    f.advance(6 * 60000);
    const started = await f.request("/auth/reverify/start", {
      method: "POST",
      token: signed.body.token,
      body: { password: person.password },
    });
    assert.equal(started.status, 200);
    const complete = await f.request("/auth/reverify/complete", {
      method: "POST",
      token: signed.body.token,
      body: {
        challenge: started.body.challenge,
        method: "totp",
        code: await f.totp(person.secret),
      },
    });
    assert.equal(complete.status, 200);
    assert.equal(
      (await f.request("/staff", { token: signed.body.token })).status,
      roles.includes("Admin") ? 200 : 403,
    );
    assert.equal(
      (await f.request("/operations", { token: signed.body.token })).body.scopes
        .length,
      0,
    );
  }
});
