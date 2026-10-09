import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { randomUUID } from "node:crypto";
import {
  activationState,
  eligibleAdmin,
  MANAGEMENT_POLICY,
  profileRevision,
} from "../src/management.js";
import {
  DEPARTMENTS,
  expectedRevision,
  expectedVersion,
  validateContact,
  validateCreate,
  validateManagementProfile,
  validateProfilePatch,
} from "../src/management-validation.js";
import { requiresMfa, ROLES } from "../src/permissions.js";
import {
  createSecurityFixture,
  digest,
  syntheticPassword,
  syntheticProfile,
} from "./helpers/security-fixture.js";

const newProfile = (overrides = {}) =>
  syntheticProfile({
    qualification: {
      type: "university",
      level: "Bachelor",
      title: "Synthetic relevant degree",
      institution: "Synthetic institution",
    },
    ...overrides,
  });
const newInput = (roles = ["Clinic Receptionist"], overrides = {}) => ({
  username: `synthetic.${randomUUID().slice(0, 16)}`,
  roles,
  profile: newProfile(),
  ...overrides,
});
const invalid = (callback) =>
  assert.throws(callback, { code: "invalid_input" });

test("new staff profiles require role-appropriate qualifications and explicit level", () => {
  for (const role of ROLES)
    assert.equal(validateCreate(newInput([role]), "2026-10-03").roles[0], role);
  for (const type of ["technical_vocational", "general_baccalaureate"]) {
    const profile = newProfile({
      qualification: {
        type,
        level: type === "technical_vocational" ? "TS" : "General",
        title: "Synthetic relevant subject",
        institution: "Synthetic institution",
      },
    });
    assert.equal(
      validateCreate(
        newInput(["Clinic Receptionist", "Lab Receptionist"], { profile }),
        "2026-10-03",
      ).profile.qualification.type,
      type,
    );
    for (const role of ROLES.slice(0, 4))
      invalid(() =>
        validateCreate(
          newInput(["Clinic Receptionist", role], { profile }),
          "2026-10-03",
        ),
      );
  }
  for (const level of ["BT", "TS", "LT"])
    invalid(() =>
      validateCreate(
        newInput(["Admin"], {
          profile: newProfile({
            qualification: {
              type: "university",
              level,
              title: "Synthetic title",
              institution: "Synthetic institution",
            },
          }),
        }),
        "2026-10-03",
      ),
    );
  invalid(() =>
    validateCreate(
      newInput(["Admin"], { profile: syntheticProfile() }),
      "2026-10-03",
    ),
  );
  invalid(() => validateCreate(newInput(["Admin", "Admin"]), "2026-10-03"));
});

test("unchanged legacy qualification stays unrecorded without guessed backfill", () => {
  const profile = syntheticProfile();
  const approved = validateManagementProfile(profile, ["Admin"], "2026-10-03", {
    legacyQualification: profile.qualification,
  });
  assert.equal(Object.hasOwn(approved.qualification, "level"), false);
  invalid(() =>
    validateManagementProfile(
      {
        ...profile,
        qualification: { ...profile.qualification, title: "Changed subject" },
      },
      ["Admin"],
      "2026-10-03",
      { legacyQualification: profile.qualification },
    ),
  );
  invalid(() =>
    validateManagementProfile(
      { ...profile, dateOfBirth: "2026-10-04" },
      ["Admin"],
      "2026-10-03",
      { legacyQualification: profile.qualification },
    ),
  );
  invalid(() =>
    validateManagementProfile(
      { ...profile, departments: ["Clinic", "Clinic"] },
      ["Admin"],
      "2026-10-03",
      { legacyQualification: profile.qualification },
    ),
  );
});

test("strict staff allowlists reject immutable email, security fields and unrelated fields", () => {
  for (const field of [
    "email",
    "roles",
    "passwordHash",
    "accountId",
    "revision",
    "jobTitle",
    "__proto__",
  ]) {
    invalid(() =>
      validateProfilePatch({
        expectedRevision: 0,
        profile: { [field]: "Synthetic input" },
      }),
    );
  }
  invalid(() =>
    validateCreate(
      { ...newInput(), password: syntheticPassword() },
      "2026-10-03",
    ),
  );
  invalid(() =>
    validateCreate(
      newInput(["Admin"], {
        profile: { ...newProfile(), jobTitle: "Not an approved field" },
      }),
      "2026-10-03",
    ),
  );
  invalid(() =>
    validateCreate(
      newInput(["Admin"], {
        profile: newProfile({
          qualification: {
            type: "university",
            level: "Bachelor",
            title: "Synthetic degree",
            institution: "Synthetic institution",
            graduationYear: 2020,
          },
        }),
      }),
      "2026-10-03",
    ),
  );
  assert.deepEqual(
    validateContact({ expectedRevision: 0, address: " Synthetic address " }),
    { expectedRevision: 0, profile: { address: "Synthetic address" } },
  );
  invalid(() =>
    validateContact({ expectedRevision: 0, firstName: "Forbidden" }),
  );
});

test("legacy profile revision is zero only when absent, never when malformed", () => {
  assert.equal(profileRevision({}), 0);
  assert.equal(profileRevision({ revision: 2 }), 2);
  for (const revision of [null, -1, 1.5, "0", NaN])
    assert.throws(() => profileRevision({ revision }), {
      code: "authority_unavailable",
    });
  for (const value of [undefined, null, -1, 1.5, "0"])
    invalid(() => expectedRevision(value));
  for (const value of [undefined, null, 0, -1, 1.5, "1"])
    invalid(() => expectedVersion(value));
});

test("only active fully enrolled acknowledged Admins count as replacements", () => {
  const admin = {
    status: "active",
    roles: ["Admin"],
    passwordHash: "Synthetic encoded password hash",
    version: 1,
    mfa: {
      enabled: true,
      version: 1,
      secretCipher: "Synthetic cipher",
      backupAcknowledged: true,
    },
  };
  assert.equal(eligibleAdmin(admin), true);
  for (const patch of [
    { status: "setup_pending" },
    { status: "mfa_pending" },
    { status: "disabled" },
    { roles: ["System Admin"] },
    { passwordHash: null },
    { version: 0 },
    { mfa: { ...admin.mfa, backupAcknowledged: false } },
    { mfa: { ...admin.mfa, enabled: false } },
    { mfa: { ...admin.mfa, secretCipher: null } },
  ])
    assert.equal(eligibleAdmin({ ...admin, ...patch }), false);
  assert.equal(MANAGEMENT_POLICY.setupMs, 30 * 60000);
  assert.equal(MANAGEMENT_POLICY.setupMaxAttempts, 5);
  assert.equal(MANAGEMENT_POLICY.recentMs, 5 * 60000);
  assert.equal(activationState(admin), "activated");
  assert.equal(
    activationState({ ...admin, status: "setup_pending" }),
    "awaiting_password",
  );
  assert.equal(
    activationState({ ...admin, status: "mfa_pending" }),
    "mfa_enrollment",
  );
  assert.equal(
    activationState({
      ...admin,
      mfa: { ...admin.mfa, backupAcknowledged: false },
    }),
    "backup_acknowledgement",
  );
  assert.equal(activationState({ ...admin, status: "disabled" }), "disabled");
});

describe("guarded staff management authority", { concurrency: false }, () => {
  let fixture;
  before(async () => {
    fixture = await createSecurityFixture();
  });
  beforeEach(async () => {
    await fixture.reset();
  });
  after(async () => {
    if (!fixture) return;
    try {
      await fixture.reset();
    } finally {
      await fixture.close();
    }
  });
  const collection = (name) => fixture.db.collection(name);
  const path = (person, action) =>
    `/staff/${encodeURIComponent(person.id)}/${action}`;
  function success(response) {
    assert.equal(response.status, 200);
    assert.equal(response.body.error, undefined);
    return response.body;
  }
  function rejected(response, code, status = 403) {
    assert.equal(response.status, status);
    assert.equal(response.body.error?.code, code);
    return response;
  }
  const post = (url, token, body) =>
    fixture.request(url, { method: "POST", token, body });
  async function signIn(person) {
    const first = success(
      await post("/auth/login", null, {
        username: person.username,
        password: person.password,
      }),
    );
    if (first.token) return first;
    assert.equal(first.kind, "mfa");
    return success(
      await post("/mfa/complete", null, {
        challenge: first.challenge,
        code: await fixture.totp(person.secret),
      }),
    );
  }
  async function managerAccount(role = "Admin") {
    const person = await fixture.account({
      roles: [role],
      mfa: true,
      departments: ["Administration"],
    });
    return { ...person, ...(await signIn(person)) };
  }
  async function createStaff(
    actor,
    roles = ["Clinic Receptionist"],
    overrides = {},
  ) {
    return success(
      await post("/staff", actor.token, newInput(roles, overrides)),
    );
  }
  async function record(id) {
    return collection("accounts").findOne({ _id: id });
  }
  async function claim(created, password = syntheticPassword()) {
    return post("/account/setup", null, {
      username: created.account.username,
      code: created.setupCode,
      password,
    });
  }

  test("all six roles have own full profile, only managers see directory or other profiles", async () => {
    const people = [];
    for (const role of ROLES) {
      const person = await fixture.account({
        roles: [role],
        mfa: requiresMfa([role]),
      });
      people.push({ ...person, ...(await signIn(person)) });
    }
    for (let index = 0; index < people.length; index += 1) {
      const person = people[index];
      const own = success(
        await fixture.request("/profiles/me", { token: person.token }),
      );
      assert.equal(own.account.id, person.id);
      for (const field of [
        "dateOfBirth",
        "fatherName",
        "motherName",
        "address",
        "email",
        "qualification",
      ])
        assert.ok(own.profile[field]);
      assert.equal(own.profile.revision, 0);
      assert.equal(own.profile.emailVerified, undefined);
      const directory = await fixture.request("/staff", {
        token: person.token,
      });
      const other = await fixture.request(
        path(people[(index + 1) % people.length], "profile"),
        { token: person.token },
      );
      if (index < 2) {
        const data = success(directory);
        assert.equal(data.staff.length, 6);
        assert.deepEqual(data.roles, [...ROLES]);
        assert.deepEqual(data.departments, [...DEPARTMENTS]);
        for (const summary of data.staff)
          assert.deepEqual(
            Object.keys(summary).sort(),
            [
              "id",
              "name",
              "username",
              "roles",
              "departments",
              "status",
              "activationState",
              "version",
              "profileRevision",
            ].sort(),
          );
        success(other);
      } else {
        rejected(directory, "permission_denied");
        rejected(other, "permission_denied");
      }
      const updated = success(
        await post("/profiles/me/contact", person.token, {
          expectedRevision: 0,
          address: "Synthetic updated own address",
        }),
      );
      assert.equal(updated.profile.revision, 1);
      rejected(
        await post(path(person, "profile"), person.token, {
          expectedRevision: 1,
          profile: { firstName: "Forbidden self rename" },
        }),
        "permission_denied",
      );
      rejected(
        await post(path(person, "roles"), person.token, {
          expectedVersion: 1,
          roles: ["Admin"],
        }),
        "permission_denied",
      );
      rejected(
        await post(path(person, "status"), person.token, {
          expectedVersion: 1,
          enabled: false,
        }),
        "permission_denied",
      );
    }
  });

  test("all roles refuse real phone changes while retaining address edits and authorized sessions", async () => {
    for (const roles of [
      ...ROLES.map((role) => [role]),
      ["System Admin", "Lab Receptionist"],
      ["Admin", "System Admin"],
    ]) {
      const account = await fixture.account({ roles, mfa: requiresMfa(roles) });
      const person = { ...account, ...(await signIn(account)) };
      const before = await collection("staff_profiles").findOne({
        accountId: person.id,
      });
      for (const fields of [
        { phone: "+000000000001" },
        { phone: before.phone },
        { phone: "+000000000001", address: "Must not be partially saved" },
      ]) {
        rejected(
          await post("/profiles/me/contact", person.token, {
            expectedRevision: 0,
            ...fields,
          }),
          "contact_change_not_ready",
          409,
        );
        rejected(
          await post(path(person, "profile"), person.token, {
            expectedRevision: 0,
            profile: fields,
          }),
          "contact_change_not_ready",
          409,
        );
        assert.deepEqual(
          await collection("staff_profiles").findOne({ accountId: person.id }),
          before,
        );
      }
      const changed = success(
        await post("/profiles/me/contact", person.token, {
          expectedRevision: 0,
          address: "Synthetic address still editable",
        }),
      );
      assert.equal(changed.profile.phone, before.phone);
      assert.equal(changed.profile.email, before.email);
      assert.equal(changed.profile.revision, 1);
      success(await fixture.request("/profiles/me", { token: person.token }));
    }
    const events = await collection("security_events")
      .find({ reason: "contact_change_not_ready" })
      .toArray();
    assert.ok(events.length > 0);
    assert.equal(JSON.stringify(events).includes("+000000000001"), false);
    assert.equal(
      JSON.stringify(events).includes("Must not be partially saved"),
      false,
    );
  });

  test("managers cannot bypass phone delivery gate, including mixed patches, concurrency and restart", async () => {
    const admin = await managerAccount();
    const system = await managerAccount("System Admin");
    const target = await fixture.account({
      roles: ["Clinic Receptionist", "Lab Receptionist"],
    });
    const before = await collection("staff_profiles").findOne({
      accountId: target.id,
    });
    for (const actor of [admin, system]) {
      for (const fields of [
        { phone: "+000000000003" },
        { phone: before.phone, fatherName: "Must not replace parent" },
        { address: "Must not replace address", phone: "+000000000003" },
      ]) {
        rejected(
          await post(path(target, "profile"), actor.token, {
            expectedRevision: 0,
            profile: fields,
          }),
          "contact_change_not_ready",
          409,
        );
        assert.deepEqual(
          await collection("staff_profiles").findOne({ accountId: target.id }),
          before,
        );
      }
    }
    const responses = await Promise.all([
      post(path(target, "profile"), admin.token, {
        expectedRevision: 0,
        profile: { phone: "+000000000003", address: "Rejected mixed race" },
      }),
      post(path(target, "profile"), system.token, {
        expectedRevision: 0,
        profile: { address: "Synthetic permitted concurrent address" },
      }),
    ]);
    rejected(responses[0], "contact_change_not_ready", 409);
    success(responses[1]);
    const changed = await collection("staff_profiles").findOne({
      accountId: target.id,
    });
    assert.equal(changed.phone, before.phone);
    assert.equal(changed.address, "Synthetic permitted concurrent address");
    assert.equal(changed.emailVerified, before.emailVerified);
    await fixture.restart({ reconnect: true });
    rejected(
      await post(path(target, "profile"), admin.token, {
        expectedRevision: 1,
        profile: { phone: "+000000000003" },
      }),
      "contact_change_not_ready",
      409,
    );
    assert.deepEqual(
      await collection("staff_profiles").findOne({ accountId: target.id }),
      changed,
    );
    success(await fixture.request("/staff", { token: admin.token }));
  });

  test("only another Admin edits identity and qualifications for all six roles and mixed accounts", async () => {
    const admin = await managerAccount();
    const bothPerson = await fixture.account({
      roles: ["Admin", "System Admin"],
      mfa: true,
    });
    const both = { ...bothPerson, ...(await signIn(bothPerson)) };
    const system = await managerAccount("System Admin");
    const systemMixedPerson = await fixture.account({
      roles: ["System Admin", "Lab Receptionist"],
      mfa: true,
    });
    const systemMixed = {
      ...systemMixedPerson,
      ...(await signIn(systemMixedPerson)),
    };
    const patches = {
      firstName: "Confirmed",
      lastName: "Synthetic",
      fatherName: "Confirmed father",
      motherName: "Confirmed mother",
      dateOfBirth: "1990-02-03",
      qualification: {
        type: "university",
        level: "Bachelor",
        title: "Confirmed synthetic degree",
        institution: "Synthetic institution",
      },
    };
    for (const roles of [
      ...ROLES.map((role) => [role]),
      ["Admin", "Clinic Receptionist"],
      ["System Admin", "Lab Admin"],
      ["Clinic Receptionist", "Lab Receptionist"],
    ]) {
      const person = await fixture.account({ roles, mfa: requiresMfa(roles) });
      const before = await collection("staff_profiles").findOne({
        accountId: person.id,
      });
      for (const actor of [system, systemMixed]) {
        for (const [field, value] of Object.entries(patches)) {
          rejected(
            await post(path(person, "profile"), actor.token, {
              expectedRevision: 0,
              profile: { [field]: value, address: "Must not partially save" },
            }),
            "permission_denied",
          );
          assert.deepEqual(
            await collection("staff_profiles").findOne({
              accountId: person.id,
            }),
            before,
          );
        }
      }
      const permitted = success(
        await post(path(person, "profile"), admin.token, {
          expectedRevision: 0,
          profile: patches,
        }),
      );
      assert.equal(permitted.profile.firstName, patches.firstName);
      assert.deepEqual(permitted.profile.qualification, patches.qualification);
      success(
        await post(path(person, "profile"), both.token, {
          expectedRevision: 1,
          profile: { motherName: "Second confirmed mother" },
        }),
      );
      const own = { ...person, ...(await signIn(person)) };
      const ownBefore = await collection("staff_profiles").findOne({
        accountId: person.id,
      });
      rejected(
        await post(path(person, "profile"), own.token, {
          expectedRevision: 2,
          profile: patches,
        }),
        "permission_denied",
      );
      assert.deepEqual(
        await collection("staff_profiles").findOne({ accountId: person.id }),
        ownBefore,
      );
    }
    for (const actor of [admin, both]) {
      rejected(
        await post(path(actor, "profile"), actor.token, {
          expectedRevision: 0,
          profile: {
            qualification: patches.qualification,
            address: "Rejected self draft",
          },
        }),
        "permission_denied",
      );
    }
  });

  test("creation transaction links account/profile and privately issues digest-only setup code", async () => {
    const actor = await managerAccount();
    const input = newInput(["Clinic Receptionist", "Lab Receptionist"], {
      username: "  synthetic.assigned  ",
    });
    const created = success(await post("/staff", actor.token, input));
    assert.equal(created.account.username, "synthetic.assigned");
    assert.equal(created.account.status, "setup_pending");
    assert.equal(created.account.version, 1);
    assert.equal(created.account.profileRevision, 0);
    assert.match(created.setupCode, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(
      new Date(created.expiresAt) - fixture.clock(),
      MANAGEMENT_POLICY.setupMs,
    );
    const account = await record(created.account.id);
    const profile = await collection("staff_profiles").findOne({
      accountId: created.account.id,
    });
    const setup = await collection("account_setup_codes").findOne({
      _id: created.account.id,
    });
    assert.equal(account.passwordHash, undefined);
    assert.equal(account.departments, undefined);
    assert.equal(profile.emailVerified, false);
    assert.equal(setup.codeHash, digest(created.setupCode));
    assert.equal(setup.accountVersion, account.version);
    assert.equal(setup.attempts, 0);
    assert.equal(setup.generation, 1);
    assert.equal(setup.consumedAt, null);
    const stored = JSON.stringify([
      account,
      profile,
      setup,
      await collection("security_events").find({}).toArray(),
    ]);
    assert.equal(stored.includes(created.setupCode), false);
    const directory = success(
      await fixture.request("/staff", { token: actor.token }),
    );
    assert.equal(JSON.stringify(directory).includes(created.setupCode), false);
    const count = await collection("accounts").countDocuments();
    rejected(
      await post("/staff", actor.token, input),
      "username_unavailable",
      409,
    );
    assert.equal(await collection("accounts").countDocuments(), count);
    assert.equal(await collection("staff_profiles").countDocuments(), count);
  });

  test("directory distinguishes backup acknowledgement from fully activated accounts without exposing MFA", async () => {
    const actor = await managerAccount();
    const pending = await fixture.account({
      roles: ["Admin"],
      mfa: true,
      backupAcknowledged: false,
    });
    const created = await createStaff(actor, ["Admin"]);
    const data = success(
      await fixture.request("/staff", { token: actor.token }),
    );
    assert.equal(
      data.staff.find((person) => person.id === pending.id).activationState,
      "backup_acknowledgement",
    );
    assert.equal(
      data.staff.find((person) => person.id === created.account.id)
        .activationState,
      "awaiting_password",
    );
    assert.equal(
      data.staff.find((person) => person.id === actor.id).activationState,
      "activated",
    );
    assert.equal(eligibleAdmin(await record(pending.id)), false);
    const summary = data.staff.find((person) => person.id === pending.id);
    for (const field of [
      "mfa",
      "passwordHash",
      "backupCodes",
      "secretCipher",
      "fatherName",
      "dateOfBirth",
      "email",
    ])
      assert.equal(Object.hasOwn(summary, field), false);
  });

  test("System Admin can manage ordinary accounts but cannot grant/remove mixed protected roles", async () => {
    const admin = await managerAccount();
    const system = await managerAccount("System Admin");
    const ordinary = await createStaff(system, ["Clinic Admin"]);
    for (const roles of [
      ["Admin"],
      ["System Admin"],
      ["Lab Receptionist", "Admin"],
    ]) {
      rejected(
        await post("/staff", system.token, newInput(roles)),
        "permission_denied",
      );
      rejected(
        await post(`/staff/${ordinary.account.id}/roles`, system.token, {
          expectedVersion: 1,
          roles,
        }),
        "permission_denied",
      );
    }
    const protectedPerson = await fixture.account({
      roles: ["Clinic Receptionist", "Admin"],
      mfa: true,
    });
    rejected(
      await post(path(protectedPerson, "roles"), system.token, {
        expectedVersion: 1,
        roles: ["Clinic Receptionist"],
      }),
      "permission_denied",
    );
    rejected(
      await post(path(protectedPerson, "status"), system.token, {
        expectedVersion: 1,
        enabled: false,
      }),
      "permission_denied",
    );
    rejected(
      await post(path(protectedPerson, "profile"), system.token, {
        expectedRevision: 0,
        profile: { fatherName: "Synthetic changed parent" },
      }),
      "permission_denied",
    );
    success(
      await post(path(protectedPerson, "profile"), system.token, {
        expectedRevision: 0,
        profile: { address: "Synthetic permitted address" },
      }),
    );
    success(
      await post(`/staff/${ordinary.account.id}/roles`, system.token, {
        expectedVersion: 1,
        roles: ["Lab Admin"],
      }),
    );
    const secondAdmin = await createStaff(admin, ["Admin"]);
    assert.deepEqual(secondAdmin.account.roles, ["Admin"]);
  });

  test("protected work fields require another Admin, including mixed roles and atomic mixed-patch rejection", async () => {
    const admin = await managerAccount();
    const system = await managerAccount("System Admin");
    const mixedSystemPerson = await fixture.account({
      roles: ["System Admin", "Clinic Admin"],
      mfa: true,
    });
    const mixedSystem = {
      ...mixedSystemPerson,
      ...(await signIn(mixedSystemPerson)),
    };
    for (const roles of [
      ["Admin"],
      ["System Admin"],
      ["Admin", "Lab Receptionist"],
      ["System Admin", "Clinic Admin"],
    ]) {
      const person = await fixture.account({ roles, mfa: true });
      const before = await collection("staff_profiles").findOne({
        accountId: person.id,
      });
      for (const actor of [system, mixedSystem]) {
        for (const patch of [
          { departments: ["Administration"] },
          { employmentStartDate: "2026-01-02" },
          { address: "Must not be saved", departments: ["Laboratory"] },
          {
            fatherName: "Must not be saved",
            employmentStartDate: "2026-01-02",
          },
          { departments: before.departments },
        ]) {
          rejected(
            await post(path(person, "profile"), actor.token, {
              expectedRevision: 0,
              profile: patch,
            }),
            "permission_denied",
          );
          assert.deepEqual(
            await collection("staff_profiles").findOne({
              accountId: person.id,
            }),
            before,
          );
        }
      }
      success(
        await post(path(person, "profile"), system.token, {
          expectedRevision: 0,
          profile: { address: "Permitted synthetic address" },
        }),
      );
      const approved = success(
        await post(path(person, "profile"), admin.token, {
          expectedRevision: 1,
          profile: {
            departments: ["Administration"],
            employmentStartDate: "2026-01-02",
          },
        }),
      );
      assert.deepEqual(approved.profile.departments, ["Administration"]);
      assert.equal(approved.profile.employmentStartDate, "2026-01-02");
      assert.equal(approved.profile.address, "Permitted synthetic address");
      assert.equal(approved.profile.fatherName, before.fatherName);
    }
    const ownBefore = await collection("staff_profiles").findOne({
      accountId: admin.id,
    });
    for (const profile of [
      { departments: ["Laboratory"] },
      {
        address: "Rejected partial self edit",
        employmentStartDate: "2026-01-02",
      },
    ]) {
      rejected(
        await post(path(admin, "profile"), admin.token, {
          expectedRevision: 0,
          profile,
        }),
        "permission_denied",
      );
      assert.deepEqual(
        await collection("staff_profiles").findOne({ accountId: admin.id }),
        ownBefore,
      );
    }
    rejected(
      await post("/profiles/me/contact", admin.token, {
        expectedRevision: 0,
        address: "Rejected partial self edit",
        departments: ["Clinic"],
      }),
      "invalid_input",
      400,
    );
    assert.deepEqual(
      await collection("staff_profiles").findOne({ accountId: admin.id }),
      ownBefore,
    );
    const events = await collection("security_events")
      .find({ action: "staff_profile_updated", outcome: "denied" })
      .toArray();
    assert.ok(events.length >= 40);
    assert.equal(JSON.stringify(events).includes("Must not be saved"), false);
  });

  test("System Admin work authority for ordinary targets uses current target roles inside the guard", async () => {
    const admin = await managerAccount();
    const system = await managerAccount("System Admin");
    for (const roles of [
      ["Clinic Admin"],
      ["Lab Admin"],
      ["Clinic Receptionist"],
      ["Lab Receptionist"],
      ["Clinic Admin", "Lab Receptionist"],
    ]) {
      const person = await fixture.account({ roles, mfa: requiresMfa(roles) });
      success(
        await post(path(person, "profile"), system.token, {
          expectedRevision: 0,
          profile: {
            departments: ["Clinic", "Laboratory"],
            employmentStartDate: "2026-01-02",
          },
        }),
      );
    }
    const promoted = await fixture.account();
    success(
      await post(path(promoted, "roles"), admin.token, {
        expectedVersion: 1,
        roles: ["System Admin", "Clinic Receptionist"],
      }),
    );
    const before = await collection("staff_profiles").findOne({
      accountId: promoted.id,
    });
    rejected(
      await post(path(promoted, "profile"), system.token, {
        expectedRevision: 0,
        profile: {
          address: "Must not bypass current roles",
          departments: ["Laboratory"],
        },
      }),
      "permission_denied",
    );
    assert.deepEqual(
      await collection("staff_profiles").findOne({ accountId: promoted.id }),
      before,
    );
    fixture.advance(MANAGEMENT_POLICY.recentMs);
    rejected(
      await post(path(promoted, "profile"), admin.token, {
        expectedRevision: 0,
        profile: { employmentStartDate: "2026-01-02" },
      }),
      "verification_required",
    );
    assert.deepEqual(
      await collection("staff_profiles").findOne({ accountId: promoted.id }),
      before,
    );
  });

  test("immutable/private field injection is rejected at manager and self endpoints", async () => {
    const actor = await managerAccount();
    const target = await fixture.account();
    const before = await collection("staff_profiles").findOne({
      accountId: target.id,
    });
    for (const field of [
      "email",
      "roles",
      "passwordHash",
      "accountId",
      "revision",
      "jobTitle",
    ]) {
      rejected(
        await post(path(target, "profile"), actor.token, {
          expectedRevision: 0,
          profile: { [field]: "Rejected private input" },
        }),
        "invalid_input",
        400,
      );
      rejected(
        await post("/profiles/me/contact", actor.token, {
          expectedRevision: 0,
          [field]: "Rejected private input",
        }),
        "invalid_input",
        400,
      );
    }
    assert.deepEqual(
      await collection("staff_profiles").findOne({ accountId: target.id }),
      before,
    );
    const updated = success(
      await post(path(target, "profile"), actor.token, {
        expectedRevision: 0,
        profile: { address: "Synthetic changed address" },
      }),
    );
    assert.equal(updated.profile.email, before.email);
    assert.deepEqual(updated.profile.qualification, before.qualification);
    assert.equal(Object.hasOwn(updated.profile.qualification, "level"), false);
  });

  test("five-minute proof boundary leaves reading/contact available and audits denial without private values", async () => {
    const actor = await managerAccount();
    const target = await fixture.account();
    fixture.advance(5 * 60000 - 1);
    success(
      await post(path(target, "profile"), actor.token, {
        expectedRevision: 0,
        profile: { firstName: "Synthetic changed name" },
      }),
    );
    fixture.advance(1);
    rejected(
      await post("/staff", actor.token, newInput()),
      "verification_required",
    );
    rejected(
      await post(path(target, "profile"), actor.token, {
        expectedRevision: 1,
        profile: { motherName: "Secret synthetic parent not logged" },
      }),
      "verification_required",
    );
    success(await fixture.request("/staff", { token: actor.token }));
    success(
      await post(path(target, "profile"), actor.token, {
        expectedRevision: 1,
        profile: { address: "Private synthetic address not logged" },
      }),
    );
    success(
      await post("/profiles/me/contact", actor.token, {
        expectedRevision: 0,
        address: "Synthetic updated own address",
      }),
    );
    const events = await collection("security_events")
      .find({ actorId: actor.id })
      .toArray();
    assert.ok(
      events.some(
        (event) =>
          event.outcome === "denied" &&
          event.reason === "verification_required",
      ),
    );
    for (const event of events)
      assert.deepEqual(
        Object.keys(event).sort(),
        [
          "_id",
          "occurredAt",
          "action",
          "accountId",
          "actorId",
          "targetAccountId",
          "outcome",
          ...(event.reason ? ["reason"] : []),
        ].sort(),
      );
    assert.equal(JSON.stringify(events).includes("Private synthetic"), false);
    assert.equal(JSON.stringify(events).includes("Secret synthetic"), false);
    assert.equal((await record(target.id)).version, 1);
  });

  test("old sessions without real factor proof cannot receive invented freshness", async () => {
    const actor = await managerAccount();
    await collection("staff_sessions").updateOne(
      { _id: digest(actor.token) },
      {
        $unset: {
          passwordVerifiedAt: "",
          mfaVerifiedAt: "",
          verificationMfaVersion: "",
        },
      },
    );
    rejected(
      await post("/staff", actor.token, newInput()),
      "verification_required",
    );
    success(await fixture.request("/profiles/me", { token: actor.token }));
    success(
      await post("/profiles/me/contact", actor.token, {
        expectedRevision: 0,
        address: "Synthetic address only",
      }),
    );
  });

  test("setup replacement invalidates old code, preserves throttle penalties and refuses installed passwords", async () => {
    const actor = await managerAccount();
    const created = await createStaff(actor);
    const bucket = {
      _id: `subject:${digest(created.account.username)}`,
      failures: 4,
      windowStartedAt: fixture.clock(),
      blockedUntil: null,
      expiresAt: new Date(fixture.clock().getTime() + 30 * 60000),
    };
    await collection("auth_throttles").insertOne(bucket);
    const replacement = success(
      await post(`/staff/${created.account.id}/setup-code`, actor.token, {
        expectedVersion: 1,
      }),
    );
    assert.notEqual(replacement.setupCode, created.setupCode);
    assert.equal(replacement.account.version, 2);
    const setup = await collection("account_setup_codes").findOne({
      _id: created.account.id,
    });
    assert.equal(setup.generation, 2);
    assert.equal(setup.codeHash, digest(replacement.setupCode));
    assert.deepEqual(
      await collection("auth_throttles").findOne({ _id: bucket._id }),
      bucket,
    );
    // The old code rejection accumulates its fifth failure rather than the
    // replacement silently bypassing the approved account cooldown.
    rejected(await claim(created), "authentication_failed", 401);
    rejected(await claim(replacement), "try_later", 429);
    assert.equal((await record(created.account.id)).passwordHash, undefined);
    fixture.advance(15 * 60000);
    const freshActor = await signIn(actor);
    const installed = await fixture.account();
    rejected(
      await post(path(installed, "setup-code"), freshActor.token, {
        expectedVersion: 1,
      }),
      "setup_not_available",
      409,
    );
  });

  test("disable/enable preserves activated factors and never revives old sessions", async () => {
    const actor = await managerAccount();
    const person = await fixture.account({ roles: ["Lab Admin"], mfa: true });
    const logged = await signIn(person);
    const before = await record(person.id);
    const disabled = success(
      await post(path(person, "status"), actor.token, {
        expectedVersion: 1,
        enabled: false,
      }),
    );
    assert.equal(disabled.account.status, "disabled");
    rejected(
      await fixture.request("/workspace", { token: logged.token }),
      "authentication_failed",
      401,
    );
    rejected(
      await post("/auth/login", null, {
        username: person.username,
        password: person.password,
      }),
      "authentication_failed",
      401,
    );
    const enabled = success(
      await post(path(person, "status"), actor.token, {
        expectedVersion: 2,
        enabled: true,
      }),
    );
    assert.equal(enabled.account.status, "active");
    const after = await record(person.id);
    assert.equal(after.passwordHash, before.passwordHash);
    assert.deepEqual(after.mfa, before.mfa);
    assert.equal(after.version, 3);
    rejected(
      await fixture.request("/workspace", { token: logged.token }),
      "authentication_failed",
      401,
    );
    fixture.advance(30000);
    success(
      await fixture.request("/workspace", {
        token: (await signIn(person)).token,
      }),
    );
  });

  test("pending disable/enable requires explicit code replacement and preserves interrupted MFA", async () => {
    const actor = await managerAccount();
    const created = await createStaff(actor, ["Clinic Admin"]);
    success(
      await post(`/staff/${created.account.id}/status`, actor.token, {
        expectedVersion: 1,
        enabled: false,
      }),
    );
    rejected(await claim(created), "authentication_failed", 401);
    success(
      await post(`/staff/${created.account.id}/status`, actor.token, {
        expectedVersion: 2,
        enabled: true,
      }),
    );
    assert.equal((await record(created.account.id)).status, "setup_pending");
    rejected(await claim(created), "authentication_failed", 401);
    const replacement = success(
      await post(`/staff/${created.account.id}/setup-code`, actor.token, {
        expectedVersion: 3,
      }),
    );
    const chosenPassword = syntheticPassword();
    const initial = success(await claim(replacement, chosenPassword));
    assert.equal(initial.kind, "enroll");
    const enrollment = success(
      await post("/mfa/enroll", null, { challenge: initial.challenge }),
    );
    const before = await record(created.account.id);
    assert.equal(before.status, "mfa_pending");
    success(
      await post(`/staff/${created.account.id}/status`, actor.token, {
        expectedVersion: before.version,
        enabled: false,
      }),
    );
    success(
      await post(`/staff/${created.account.id}/status`, actor.token, {
        expectedVersion: before.version + 1,
        enabled: true,
      }),
    );
    const after = await record(created.account.id);
    assert.equal(after.status, "mfa_pending");
    assert.equal(after.passwordHash, before.passwordHash);
    assert.deepEqual(
      after.pendingMfaSecretCipher,
      before.pendingMfaSecretCipher,
    );
    rejected(
      await post(`/staff/${created.account.id}/setup-code`, actor.token, {
        expectedVersion: after.version,
      }),
      "setup_not_available",
      409,
    );
    rejected(
      await post("/mfa/enroll", null, { challenge: initial.challenge }),
      "authentication_failed",
      401,
    );
    const resumed = success(
      await post("/auth/login", null, {
        username: replacement.account.username,
        password: chosenPassword,
      }),
    );
    assert.equal(resumed.kind, "enroll");
    const retained = success(
      await post("/mfa/enroll", null, { challenge: resumed.challenge }),
    );
    assert.equal(retained.secret, enrollment.secret);
  });

  test("first administrative promotion enrolls MFA and demotion retains existing factors", async () => {
    const actor = await managerAccount();
    const person = await fixture.account();
    const first = await signIn(person);
    const before = await record(person.id);
    const promoted = success(
      await post(path(person, "roles"), actor.token, {
        expectedVersion: 1,
        roles: ["Clinic Receptionist", "Clinic Admin"],
      }),
    );
    assert.equal(promoted.account.status, "mfa_pending");
    rejected(
      await fixture.request("/workspace", { token: first.token }),
      "authentication_failed",
      401,
    );
    const resumed = success(
      await post("/auth/login", null, {
        username: person.username,
        password: person.password,
      }),
    );
    assert.equal(resumed.kind, "enroll");
    assert.equal((await record(person.id)).passwordHash, before.passwordHash);
    const enrolled = await fixture.account({ roles: ["Lab Admin"], mfa: true });
    const oldLogin = await signIn(enrolled);
    const existing = await record(enrolled.id);
    success(
      await post(path(enrolled, "roles"), actor.token, {
        expectedVersion: 1,
        roles: ["Lab Receptionist"],
      }),
    );
    const demoted = await record(enrolled.id);
    assert.equal(demoted.status, "active");
    assert.deepEqual(demoted.mfa, existing.mfa);
    rejected(
      await fixture.request("/workspace", { token: oldLogin.token }),
      "authentication_failed",
      401,
    );
    const receptionLogin = await signIn(enrolled);
    assert.deepEqual(receptionLogin.user.roles, ["Lab Receptionist"]);
    assert.equal(receptionLogin.backupCodes, undefined);
  });

  test("stale concurrent profile and account edits reject instead of silently overwriting", async () => {
    const actor = await managerAccount();
    const person = await fixture.account();
    const changes = await Promise.all(
      ["Synthetic first address", "Synthetic second address"].map((address) =>
        post(path(person, "profile"), actor.token, {
          expectedRevision: 0,
          profile: { address },
        }),
      ),
    );
    assert.deepEqual(
      changes.map((response) => response.status).sort(),
      [200, 409],
    );
    assert.equal(
      changes.find((response) => response.status === 409).body.error.code,
      "stale_record",
    );
    assert.equal(
      (await collection("staff_profiles").findOne({ accountId: person.id }))
        .revision,
      1,
    );
    const roles = await Promise.all(
      [["Clinic Admin"], ["Lab Admin"]].map((value) =>
        post(path(person, "roles"), actor.token, {
          expectedVersion: 1,
          roles: value,
        }),
      ),
    );
    assert.deepEqual(
      roles.map((response) => response.status).sort(),
      [200, 409],
    );
    assert.equal((await record(person.id)).version, 2);
  });

  test("qualification and promotion races leave only a role-appropriate profile", async () => {
    const actor = await managerAccount();
    const person = await fixture.account();
    const responses = await Promise.all([
      post(path(person, "profile"), actor.token, {
        expectedRevision: 0,
        profile: {
          qualification: {
            type: "technical_vocational",
            level: "TS",
            title: "Synthetic relevant subject",
            institution: "Synthetic institution",
          },
        },
      }),
      post(path(person, "roles"), actor.token, {
        expectedVersion: 1,
        roles: ["Clinic Admin"],
      }),
    ]);
    assert.deepEqual(
      responses.map((response) => response.status).sort(),
      [200, 400],
    );
    const account = await record(person.id);
    const profile = await collection("staff_profiles").findOne({
      accountId: person.id,
    });
    assert.ok(
      !requiresMfa(account.roles) ||
        profile.qualification.type === "university",
    );
  });

  test("concurrent cross-Admin disable/demotion never removes all eligible Admins", async () => {
    const first = await managerAccount();
    const second = await managerAccount();
    const pending = await createStaff(first, ["Admin"]);
    assert.equal(eligibleAdmin(await record(pending.account.id)), false);
    const results = await Promise.all([
      post(path(second, "status"), first.token, {
        expectedVersion: 1,
        enabled: false,
      }),
      post(path(first, "roles"), second.token, {
        expectedVersion: 1,
        roles: ["Clinic Receptionist"],
      }),
    ]);
    assert.equal(
      results.filter((response) => response.status === 200).length,
      1,
    );
    assert.ok(
      results.some((response) => [401, 403, 409].includes(response.status)),
    );
    assert.equal(
      (await collection("accounts").find({}).toArray()).filter(eligibleAdmin)
        .length,
      1,
    );
  });

  test("audit insertion failure rolls back account, profile, code and membership guard changes", async () => {
    const actor = await managerAccount();
    const beforeGuard = await collection("staff_management_state").findOne({
      _id: "staff-controls",
    });
    const beforeCounts = await Promise.all(
      [
        "accounts",
        "staff_profiles",
        "account_setup_codes",
        "security_events",
      ].map((name) => collection(name).countDocuments()),
    );
    await fixture.restart({ failAudit: true });
    rejected(
      await post("/staff", actor.token, newInput()),
      "authority_unavailable",
      503,
    );
    assert.deepEqual(
      await Promise.all(
        [
          "accounts",
          "staff_profiles",
          "account_setup_codes",
          "security_events",
        ].map((name) => collection(name).countDocuments()),
      ),
      beforeCounts,
    );
    assert.deepEqual(
      await collection("staff_management_state").findOne({
        _id: "staff-controls",
      }),
      beforeGuard,
    );
    await fixture.restart();
    const created = await createStaff(actor);
    assert.equal(created.account.status, "setup_pending");
  });

  test("management records and unused setup code survive API/database connection restart", async () => {
    const actor = await managerAccount();
    const created = await createStaff(actor);
    const before = await record(created.account.id);
    await fixture.restart({ reconnect: true });
    const directory = success(
      await fixture.request("/staff", { token: actor.token }),
    );
    assert.equal(
      directory.staff.filter((person) => person.id === created.account.id)
        .length,
      1,
    );
    assert.deepEqual(await record(created.account.id), before);
    const activated = success(await claim(created));
    assert.equal(activated.user.id, created.account.id);
    const setup = await collection("account_setup_codes").findOne({
      _id: created.account.id,
    });
    assert.ok(setup.consumedAt instanceof Date);
    rejected(await claim(created), "authentication_failed", 401);
  });
});
