import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transformSync } from "rolldown/utils";
import {
  accountStatusLabel,
  assertManagementActionLive,
  assignableRoles,
  canControlAccount,
  canManageProfile,
  canManageIdentity,
  canManageWorkDetails,
  canReleaseEmail,
  canViewStaffDirectory,
  changedProfileFields,
  filterStaff,
  handoffExpiry,
  refreshedAddress,
  contactLabel,
  isAccessError,
  managementErrorMessage,
  managementProfile,
  preservesLegacyQualification,
  STAFF_STATUS_OPTIONS,
  staffStatusKey,
  statusLabel,
  USERNAME_PATTERN,
  validateManagementProfile,
} from "../src/lib/staffManagement.js";

// Reuse Vite's installed JSX transformer without a DOM library, database, or
// generated files. The hook applies only to this workspace's JSX source.
const sourceRoot = new URL("../src/", import.meta.url).href;
const jsxHook = registerHooks({
  load(url, context, nextLoad) {
    if (!url.startsWith(sourceRoot) || !url.endsWith(".jsx"))
      return nextLoad(url, context);
    const code = transformSync(
      fileURLToPath(url),
      readFileSync(fileURLToPath(url), "utf8"),
      { jsx: { runtime: "automatic" } },
    ).code;
    return { format: "module", source: code, shortCircuit: true };
  },
});
after(() => jsxHook.deregister());

const roles = [
  "Admin",
  "System Admin",
  "Clinic Admin",
  "Lab Admin",
  "Clinic Receptionist",
  "Lab Receptionist",
];
const actor = (assignedRoles, id = "actor") => ({ id, roles: assignedRoles });
const target = (assignedRoles, id = "target") => ({ id, roles: assignedRoles });
const staff = [
  {
    id: "one",
    name: "Synthetic One",
    username: "synthetic.one",
    roles: ["Admin"],
    departments: ["Administration"],
    status: "active",
  },
  {
    id: "two",
    name: "Synthetic Two",
    username: "synthetic.two",
    roles: ["Lab Receptionist", "Clinic Receptionist"],
    departments: ["Laboratory", "Clinic"],
    status: "setup_pending",
  },
];

test("shared form fields top-align without fixed row or field heights", () => {
  const styles = readFileSync(
    new URL("../src/styles.css", import.meta.url),
    "utf8",
  );
  const grid = styles.match(/\.staff-form-grid\s*\{([^}]+)\}/)?.[1];
  const field = styles.match(/\.staff-field\s*\{([^}]+)\}/)?.[1];
  assert.ok(grid && field, "Shared form styles must remain present.");
  assert.match(grid, /align-items:\s*start\s*;/);
  assert.match(field, /align-content:\s*start\s*;/);
  assert.doesNotMatch(grid, /(?:height|grid-auto-rows|grid-template-rows)\s*:/);
  assert.doesNotMatch(
    field,
    /(?:height|grid-auto-rows|grid-template-rows)\s*:/,
  );
});

test("profile contact groups keep Address/Email together before Phone in DOM order", async () => {
  const { default: StaffProfileFields } =
    await import("../src/components/StaffProfileFields.jsx");
  const { SetupForm } = await import("../src/components/AuthForms.jsx");
  for (const element of [
    createElement(StaffProfileFields),
    createElement(StaffProfileFields, { phoneLocked: true, emailLocked: true }),
    createElement(SetupForm, { busy: false }),
  ]) {
    const html = renderToStaticMarkup(element);
    assert.equal((html.match(/class="staff-contact-stack"/g) ?? []).length, 2);
    const address = html.indexOf('name="address"');
    const email = html.indexOf('name="email"');
    const phone = html.indexOf('name="phone');
    assert.ok(address > 0 && email > address && phone > email);
    assert.equal((html.match(/name="address"/g) ?? []).length, 1);
    assert.equal((html.match(/name="email"/g) ?? []).length, 1);
    assert.equal((html.match(/name="phone"/g) ?? []).length, 1);
  }
});

test("assigned username pattern is valid under Chromium HTML Unicode-set rules", () => {
  const pattern = new RegExp(`^(?:${USERNAME_PATTERN})$`, "v");
  for (const value of ["synthetic.one", "Synthetic_2", "staff-test", "abc"])
    assert.equal(pattern.test(value), true);
  for (const value of ["ab", "staff test", "staff/test", "a".repeat(41)])
    assert.equal(pattern.test(value), false);
});

test("directory searches names/secondary usernames with case and whitespace normalization; clearing restores all", () => {
  assert.deepEqual(
    filterStaff(staff, { query: "  SYNTHETIC   ONE " }).map(({ id }) => id),
    ["one"],
  );
  assert.deepEqual(
    filterStaff(staff, { query: "synthetic.two" }).map(({ id }) => id),
    ["two"],
  );
  assert.deepEqual(filterStaff(staff, { query: "   " }), staff);
  assert.deepEqual(filterStaff(staff, { query: "does not exist" }), []);
  assert.deepEqual(filterStaff(staff, { query: "" }), staff);
});
test("role, department and status filters combine and mixed assignments remain discoverable", () => {
  assert.deepEqual(
    filterStaff(staff, {
      role: "Clinic Receptionist",
      department: "Laboratory",
      status: "setup_pending",
    }).map(({ id }) => id),
    ["two"],
  );
  assert.deepEqual(
    filterStaff(staff, { role: "Admin", department: "Clinic" }),
    [],
  );
  assert.deepEqual(filterStaff([], {}), []);
});
test("derived activation labels and filters do not disguise pending backup acknowledgement as Active", () => {
  const pending = { ...staff[0], activationState: "backup_acknowledgement" };
  const active = {
    ...staff[1],
    status: "active",
    activationState: "activated",
  };
  assert.equal(accountStatusLabel(pending), "Backup acknowledgement pending");
  assert.equal(staffStatusKey(pending), "backup_acknowledgement");
  assert.deepEqual(filterStaff([pending, active], { status: "activated" }), [
    active,
  ]);
  assert.deepEqual(
    filterStaff([pending, active], { query: "BACKUP acknowledgement" }),
    [pending],
  );
  assert.equal(accountStatusLabel(staff[0]), "Active");
  assert.equal(
    staffStatusKey({ ...pending, activationState: "unexpected" }),
    "activated",
  );
  assert.equal(staffStatusKey({ status: "unexpected" }), "unknown");
  assert.equal(accountStatusLabel({ status: "unexpected" }), "Unknown status");
  assert.deepEqual(
    STAFF_STATUS_OPTIONS.map(({ value }) => value),
    [
      "awaiting_password",
      "mfa_enrollment",
      "backup_acknowledgement",
      "activated",
      "disabled",
    ],
  );
  assert.equal(Object.isFrozen(STAFF_STATUS_OPTIONS), true);
});
test("closed management screens cannot start or retry a pending protected action", () => {
  assert.doesNotThrow(() => assertManagementActionLive(true));
  assert.throws(
    () => assertManagementActionLive(false),
    (error) => error.code === "action_cancelled",
  );
});
test("presentation permissions hide self controls and protect every mixed Admin/System Admin target", () => {
  for (const role of roles)
    assert.equal(
      canViewStaffDirectory(actor([role])),
      ["Admin", "System Admin"].includes(role),
    );
  assert.equal(
    canManageProfile(actor(["System Admin"]), target(["Admin"])),
    true,
  );
  assert.equal(
    canControlAccount(
      actor(["System Admin"]),
      target(["Admin", "Clinic Receptionist"]),
    ),
    false,
  );
  assert.equal(
    canControlAccount(
      actor(["System Admin"]),
      target(["System Admin", "Lab Admin"]),
    ),
    false,
  );
  assert.equal(
    canControlAccount(actor(["System Admin"]), target(["Clinic Admin"])),
    true,
  );
  assert.equal(
    canControlAccount(actor(["Admin"]), target(["System Admin"])),
    true,
  );
  for (const role of roles)
    assert.equal(
      canControlAccount(actor([role]), target([role], "actor")),
      false,
    );
  assert.deepEqual(
    assignableRoles(actor(["System Admin"]), roles),
    roles.slice(2),
  );
  assert.deepEqual(assignableRoles(actor(["Admin"]), roles), roles);
  assert.deepEqual(assignableRoles(actor(["Lab Admin"]), roles), []);
});
test("work-detail editability distinguishes other protected accounts without restricting personal fields", () => {
  for (const protectedTarget of [
    ["Admin"],
    ["System Admin"],
    ["Admin", "Clinic Receptionist"],
    ["System Admin", "Lab Admin"],
  ]) {
    assert.equal(
      canManageWorkDetails(actor(["System Admin"]), target(protectedTarget)),
      false,
    );
    assert.equal(
      canManageWorkDetails(
        actor(["System Admin", "Clinic Admin"]),
        target(protectedTarget),
      ),
      false,
    );
    assert.equal(
      canManageProfile(actor(["System Admin"]), target(protectedTarget)),
      true,
    );
    assert.equal(
      canManageWorkDetails(actor(["Admin"]), target(protectedTarget)),
      true,
    );
    assert.equal(
      canManageWorkDetails(
        actor(["System Admin", "Admin"]),
        target(protectedTarget),
      ),
      true,
    );
  }
  for (const role of roles) {
    assert.equal(
      canManageWorkDetails(actor([role]), target([role], "actor")),
      false,
    );
    if (!["Admin", "System Admin"].includes(role)) {
      assert.equal(
        canManageWorkDetails(actor(["System Admin"]), target([role])),
        true,
      );
      assert.equal(
        canManageWorkDetails(actor([role]), target(["Admin"])),
        false,
      );
    }
  }
});

function profileData() {
  const data = new FormData();
  for (const [key, value] of Object.entries({
    firstName: " Synthetic ",
    lastName: "Staff",
    fatherName: "Parent",
    motherName: "Parent",
    dateOfBirth: "1990-01-01",
    address: "Synthetic address",
    phone: "+96171123456",
    email: "synthetic@example.invalid",
    employmentStartDate: "2026-10-03",
    qualificationType: "university",
    qualificationLevel: "Bachelor",
    qualificationTitle: "Synthetic relevant subject",
    qualificationInstitution: "Synthetic university",
    revision: "88",
    accountId: "not a profile field",
    password: "never copied",
    roles: "Admin",
  }))
    data.append(key, value);
  data.append("departments", "Clinic");
  data.append("departments", "Administration");
  return data;
}
test("manager profile allowlist excludes credentials/account/revision fields and locked email on updates", () => {
  const profile = managementProfile(profileData());
  assert.equal(profile.firstName, "Synthetic");
  assert.equal(profile.email, "synthetic@example.invalid");
  assert.deepEqual(profile.departments, ["Clinic", "Administration"]);
  for (const key of ["revision", "accountId", "password", "roles"])
    assert.equal(Object.hasOwn(profile, key), false);
  assert.equal(
    Object.hasOwn(
      managementProfile(profileData(), { includeEmail: false }),
      "email",
    ),
    false,
  );
});
test("changed profile patches keep address/phone-only edits separate from sensitive identity changes", () => {
  const existing = managementProfile(profileData());
  assert.deepEqual(
    changedProfileFields(
      { ...existing, departments: [...existing.departments].reverse() },
      existing,
    ),
    {},
  );
  assert.deepEqual(
    changedProfileFields(
      {
        ...existing,
        address: "New synthetic address",
        phone: "New synthetic phone",
      },
      existing,
    ),
    { address: "New synthetic address", phone: "New synthetic phone" },
  );
  assert.deepEqual(
    changedProfileFields(
      {
        ...existing,
        motherName: "Different given name",
        email: "ignored@example.invalid",
        revision: 100,
      },
      existing,
    ),
    { motherName: "Different given name" },
  );
  const legacy = {
    ...existing,
    qualification: {
      type: "university",
      title: "Existing degree",
      institution: "Existing institution",
    },
  };
  assert.deepEqual(
    changedProfileFields(
      { ...legacy, qualification: { ...legacy.qualification, level: "" } },
      legacy,
    ),
    {},
  );
  assert.deepEqual(
    changedProfileFields(
      {
        ...legacy,
        qualification: { ...legacy.qualification, level: "Bachelor" },
      },
      legacy,
    ),
    { qualification: { ...legacy.qualification, level: "Bachelor" } },
  );
});
test("qualifications validate the full role list; technical levels never silently become university degrees", () => {
  const profile = managementProfile(profileData());
  assert.equal(
    validateManagementProfile(profile, ["Admin", "Lab Receptionist"]),
    "",
  );
  const vocational = {
    ...profile,
    qualification: {
      ...profile.qualification,
      type: "technical_vocational",
      level: "TS",
    },
  };
  assert.equal(validateManagementProfile(vocational, ["Lab Receptionist"]), "");
  assert.match(
    validateManagementProfile(vocational, ["Lab Receptionist", "Clinic Admin"]),
    /university/,
  );
  const baccalaureate = {
    ...profile,
    qualification: {
      ...profile.qualification,
      type: "general_baccalaureate",
      level: "General Baccalaureate",
    },
  };
  assert.equal(
    validateManagementProfile(baccalaureate, ["Clinic Receptionist"]),
    "",
  );
  assert.match(
    validateManagementProfile(
      { ...profile, qualification: { ...profile.qualification, level: "BT" } },
      ["Admin"],
    ),
    /technical/,
  );
  assert.match(validateManagementProfile(profile, []), /role/);
  assert.match(
    validateManagementProfile({ ...profile, departments: [] }, ["Admin"]),
    /department/,
  );
});
test("legacy missing qualification level is preserved only when qualification is exactly unchanged", () => {
  const data = profileData();
  data.set("qualificationLevel", "");
  const profile = managementProfile(data),
    existing = { ...profile.qualification };
  assert.equal(Object.hasOwn(profile.qualification, "level"), false);
  assert.equal(
    preservesLegacyQualification(profile.qualification, existing),
    true,
  );
  assert.equal(validateManagementProfile(profile, ["Admin"], existing), "");
  assert.match(validateManagementProfile(profile, ["Admin"]), /level/);
  assert.match(
    validateManagementProfile(
      {
        ...profile,
        qualification: { ...profile.qualification, title: "Changed subject" },
      },
      ["Admin"],
      existing,
    ),
    /level/,
  );
});
test("safe errors and status labels do not fabricate an unavailable directory or completed activation", () => {
  assert.equal(statusLabel("setup_pending"), "Password setup pending");
  assert.equal(statusLabel("mfa_pending"), "MFA enrollment pending");
  assert.equal(statusLabel("unexpected"), "Unknown status");
  assert.equal(
    managementErrorMessage({ message: "Reload the stale record." }),
    "Reload the stale record.",
  );
  assert.match(managementErrorMessage({}), /could not/);
  assert.equal(isAccessError({ code: "authority_unavailable" }), true);
  assert.equal(isAccessError({ code: "verification_failed" }), false);
  assert.equal(isAccessError({ code: "verification_required" }), false);
  assert.equal(isAccessError({ code: "verification_expired" }), false);
  assert.equal(isAccessError({ code: "contact_change_not_ready" }), false);
  assert.equal(isAccessError({ code: "SESSION_EXPIRED" }), true);
  assert.equal(handoffExpiry("invalid"), "Not provided by the server");
  assert.match(handoffExpiry("2026-10-03T08:00:00.000Z"), /3 Oct 2026/);
});

test("shared profile fields render associated required labels and keep immutable email read-only", async () => {
  const { default: Fields } =
    await import("../src/components/StaffProfileFields.jsx");
  const blank = renderToStaticMarkup(createElement(Fields));
  for (const label of [
    "First name",
    "Last name",
    "Father’s given name",
    "Mother’s name (given name only)",
    "Date of birth",
    "Individual email",
    "Qualification level",
  ])
    assert.ok(blank.includes(label));
  assert.equal(blank.includes("maiden"), false);
  assert.match(
    blank.match(/<input[^>]+name="qualificationLevel"[^>]*>/)[0],
    /required/,
  );
  const existing = managementProfile(profileData());
  delete existing.qualification.level;
  const legacy = renderToStaticMarkup(
    createElement(Fields, { profile: existing, emailLocked: true }),
  );
  assert.match(legacy.match(/<input[^>]+name="email"[^>]*>/)[0], /readonly/i);
  assert.doesNotMatch(
    legacy.match(/<input[^>]+name="qualificationLevel"[^>]*>/)[0],
    /required/,
  );
  assert.match(legacy, /no recorded level/);
});

test("locked work controls retain visible values while unrelated personal fields remain editable", async () => {
  const { default: Fields } =
    await import("../src/components/StaffProfileFields.jsx");
  const profile = managementProfile(profileData());
  const locked = renderToStaticMarkup(
    createElement(Fields, {
      profile,
      emailLocked: true,
      workDetailsLocked: true,
    }),
  );
  assert.match(
    locked.match(/<input[^>]+name="employmentStartDate"[^>]*>/)[0],
    /readonly/i,
  );
  assert.match(
    locked,
    /<fieldset disabled=""[^>]*><legend>Departments — read-only/,
  );
  for (const field of [
    "firstName",
    "fatherName",
    "dateOfBirth",
    "address",
    "phone",
  ]) {
    assert.doesNotMatch(
      locked.match(new RegExp(`<input[^>]+name="${field}"[^>]*>`))[0],
      /readonly|disabled/i,
    );
  }
  assert.match(locked, /Only another Admin may change/);
  const unlocked = renderToStaticMarkup(
    createElement(Fields, { profile, workDetailsLocked: false }),
  );
  assert.doesNotMatch(
    unlocked.match(/<input[^>]+name="employmentStartDate"[^>]*>/)[0],
    /readonly/i,
  );
  assert.match(unlocked, /Departments — choose at least one/);
});

test("own profile details include private agreed fields but no security secrets or invented missing level", async () => {
  const { ProfileDetails } = await import("../src/components/StaffProfile.jsx");
  const profile = managementProfile(profileData());
  delete profile.qualification.level;
  const html = renderToStaticMarkup(
    createElement(ProfileDetails, {
      account: { ...staff[0], passwordHash: "must-not-display" },
      profile,
    }),
  );
  for (const label of [
    "Date of birth",
    "Father’s given name",
    "Mother’s name",
    "Address",
    "Phone",
    "Qualification level",
    "Not recorded",
  ])
    assert.ok(html.includes(label));
  assert.equal(html.includes("must-not-display"), false);
  assert.match(html, /Phone — unverified/);
  assert.match(html, /Individual email — unverified, contact only/);
});

test("saved manager phone stays read-only while account creation still collects an unverified initial number", async () => {
  const { default: Fields } =
    await import("../src/components/StaffProfileFields.jsx");
  const profile = managementProfile(profileData());
  const html = renderToStaticMarkup(
    createElement(Fields, { profile, phoneLocked: true, emailLocked: true }),
  );
  assert.match(html.match(/<input[^>]+name="phone"[^>]*>/)[0], /readonly/i);
  assert.match(html, /Saved phone — unverified/);
  assert.match(
    html,
    /until real WhatsApp verification is configured and tested/,
  );
  assert.doesNotMatch(
    html.match(/<input[^>]+name="address"[^>]*>/)[0],
    /readonly|disabled/i,
  );
  const blank = renderToStaticMarkup(createElement(Fields));
  assert.doesNotMatch(
    blank.match(/<input[^>]+name="phone"[^>]*>/)[0],
    /readonly|disabled/i,
  );
});

test("own profile has an address-only editor and an honest delivery-unavailable explanation", async () => {
  const { default: Profile } =
    await import("../src/components/StaffProfile.jsx");
  const html = renderToStaticMarkup(createElement(Profile, { api: {} }));
  assert.match(
    html,
    /Phone changes are unavailable until real WhatsApp delivery is configured and successfully tested/,
  );
  assert.match(
    html,
    /No simulated delivery verifies your saved contacts or enables recovery/,
  );
  const source = readFileSync(
    new URL("../src/components/StaffProfile.jsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /Edit profile/);
  assert.doesNotMatch(source, /name="phone"|phone: String\(data\.get/);
  assert.match(source, /emailOpen\s*&&\s*\(?\s*<ContactChange/);
  assert.match(source, /"Save changes"/);
  assert.match(source, />\s*Cancel\s*<\/button>/);
  assert.doesNotMatch(source, /Save address|Cancel address editing/);
  assert.match(
    source,
    /updateOwnContact\(\{\s*expectedRevision:[^,]+,\s*address:\s*address\.trim\(\),?\s*\}\)/,
  );
  assert.doesNotMatch(source, /key=\{record.profile.revision\}/);
});

test("directory loading never invents staff and verification renders a labelled private dialog", async () => {
  const { default: Directory } =
    await import("../src/components/StaffDirectory.jsx");
  const { default: Verification } =
    await import("../src/components/ManagerVerification.jsx");
  const directory = renderToStaticMarkup(
    createElement(Directory, { api: {}, user: actor(["Admin"]) }),
  );
  assert.match(directory, /Loading staff directory/);
  assert.match(directory, /tabindex="-1"/i);
  assert.equal(directory.includes("synthetic.one"), false);
  const verification = renderToStaticMarkup(
    createElement(Verification, { api: {} }),
  );
  assert.match(verification, /role="dialog"/);
  assert.match(verification, /aria-modal="true"/);
  assert.match(verification, /Your current password or passphrase/);
  assert.match(verification, /Cancel action/);
  assert.doesNotMatch(verification, /value="[^"\s]+"/);
});

test("contact screen is honest about pending verification, unavailable WhatsApp and TEST-only labels", async () => {
  const { default: Contacts } =
    await import("../src/components/ContactChange.jsx");
  const html = renderToStaticMarkup(
    createElement(Contacts, { api: {}, revision: 0 }),
  );
  assert.match(html, /Checking contact delivery/);
  assert.match(html, /saved email stays unchanged/);
  assert.match(html, /Phone changes are unavailable/);
  assert.match(html, /does not enable password recovery/);
  assert.equal(contactLabel("verified"), "verified");
  assert.equal(contactLabel("unexpected"), "unverified");
  assert.match(contactLabel("test_only"), /not real verification/);
  for (const code of [
    "contact_try_later",
    "contact_request_expired",
    "contact_delivery_failed",
  ])
    assert.equal(isAccessError({ code }), false);
  assert.equal(isAccessError({ code: "session_revoked" }), true);
  assert.equal(
    isAccessError({ code: "contact_email_already_verified" }),
    false,
  );
  const source = readFileSync(
    new URL("../src/components/ContactChange.jsx", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /localStorage|\.activity\(/);
  assert.match(
    source,
    /setInterval\(\(\) => setClock\(Date\.now\(\)\), 1000\)/,
  );
  assert.match(source, /type="password"/);
  assert.match(source, /<EmailInput/);
  assert.match(source, /inputMode="numeric"/);
});

test("identity permission is other-Admin-only independently of target roles", () => {
  for (const roles of [
    ["Admin"],
    ["System Admin"],
    ["Clinic Admin"],
    ["Lab Admin"],
    ["Clinic Receptionist"],
    ["Lab Receptionist"],
    ["Admin", "System Admin"],
    ["System Admin", "Lab Receptionist"],
  ]) {
    const user = actor(roles);
    for (const targetRoles of [
      ["Admin"],
      ["System Admin"],
      ["Clinic Admin"],
      ["Lab Admin"],
      ["Clinic Receptionist"],
      ["Lab Receptionist"],
      ["Admin", "Lab Receptionist"],
    ]) {
      assert.equal(
        canManageIdentity(user, { id: "other", roles: targetRoles }),
        roles.includes("Admin"),
      );
      assert.equal(
        canManageIdentity(user, { id: user.id, roles: targetRoles }),
        false,
      );
    }
  }
});

test("identity and qualification controls remain visible but read-only for System Admin", async () => {
  const { default: Fields } =
    await import("../src/components/StaffProfileFields.jsx");
  const html = renderToStaticMarkup(
    createElement(Fields, {
      profile: managementProfile(profileData()),
      identityLocked: true,
    }),
  );
  for (const field of [
    "firstName",
    "lastName",
    "fatherName",
    "motherName",
    "dateOfBirth",
  ])
    assert.match(
      html.match(new RegExp(`<input[^>]+name="${field}"[^>]*>`))[0],
      /readonly/i,
    );
  assert.match(
    html,
    /<fieldset disabled=""[^>]*><legend>One actual qualification — read-only/,
  );
  assert.match(
    html,
    /Only another Admin may change these fields on any staff profile/,
  );
  for (const field of ["address", "employmentStartDate"])
    assert.doesNotMatch(
      html.match(new RegExp(`<input[^>]+name="${field}"[^>]*>`))[0],
      /readonly|disabled/i,
    );
});

test("email refresh preserves dirty addresses and identifies concurrent address conflicts", () => {
  assert.deepEqual(
    refreshedAddress(
      { address: "saved" },
      { address: "saved", revision: 2 },
      "draft",
    ),
    { draft: "draft", conflict: false },
  );
  assert.deepEqual(
    refreshedAddress({ address: "saved" }, { address: "new saved" }, "draft"),
    { draft: "draft", conflict: true },
  );
  assert.deepEqual(
    refreshedAddress({ address: "saved" }, { address: "new saved" }, "saved"),
    { draft: "new saved", conflict: false },
  );
});

test("email dialog uses native modal focus containment, safe cancellation and one text code field", async () => {
  const { default: Contact } =
    await import("../src/components/ContactChange.jsx");
  const html = renderToStaticMarkup(
    createElement(Contact, { api: {}, roles: ["Admin"] }),
  );
  assert.match(html, /<dialog[^>]+aria-modal="true"[^>]+aria-labelledby=/);
  assert.match(html, /Cancel email change/);
  const source = readFileSync(
    new URL("../src/components/ContactChange.jsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /showModal\(\)/);
  assert.match(source, /returnFocus\?\.current\?\.focus/);
  assert.match(source, /event\.preventDefault\(\);\s*cancelRef\.current\(\)/);
  assert.match(source, /result.cancelled !== true/);
  assert.match(source, /name="code"\s+type="text"/);
  assert.equal((source.match(/<input[^>]+name="code"/g) ?? []).length, 1);
  assert.match(source, /if \(inFlight.current/);
  assert.match(source, /"contact_email_already_verified"/);
  assert.match(source, /"contact_email_in_use"/);
});

test("release controls require another disabled account, Admin authority and authoritative derived proof status", () => {
  for (const roleList of [
    ...roles.map((role) => [role]),
    ["Admin", "System Admin"],
    ["System Admin", "Lab Admin"],
  ]) {
    const user = actor(roleList);
    for (const email of ["verified", "test_only", "unverified", "released"]) {
      const record = {
        account: {
          ...target(["Admin", "Clinic Receptionist"]),
          status: "disabled",
        },
        profile: { contactStatus: { email } },
      };
      assert.equal(
        canReleaseEmail(user, record),
        roleList.includes("Admin") && ["verified", "test_only"].includes(email),
      );
      assert.equal(
        canReleaseEmail(user, {
          ...record,
          account: { ...record.account, id: user.id },
        }),
        false,
      );
      assert.equal(
        canReleaseEmail(user, {
          ...record,
          account: { ...record.account, status: "active" },
        }),
        false,
      );
    }
  }
  assert.match(contactLabel("released"), /released/);
});

test("shared contact controls expose labelled country selection and consistent email syntax without validating locked legacy contacts", async () => {
  const { default: EmailInput } =
    await import("../src/components/EmailInput.jsx");
  const { default: PhoneInput } =
    await import("../src/components/PhoneInput.jsx");
  const email = renderToStaticMarkup(createElement(EmailInput, { value: "" }));
  assert.match(email, /inputMode="email"/i);
  assert.match(email, /<label[^>]+for=/);
  const phone = renderToStaticMarkup(createElement(PhoneInput));
  assert.match(phone, /Phone country/);
  assert.match(phone, /value="LB" selected=""/);
  assert.match(phone, /Lebanon \+961/);
  assert.match(phone, /United States \+1/);
  assert.match(
    phone.match(/<input[^>]+name="phoneNational"[^>]*>/)[0],
    /type="tel"/,
  );
  assert.match(
    phone.match(/<input[^>]+name="phone"[^>]*>/)[0],
    /type="hidden"/,
  );
  assert.match(phone, /Structure is not ownership verification/);
  const legacy = {
    ...managementProfile(profileData()),
    email: "legacy synthetic",
    phone: "000 placeholder",
  };
  assert.equal(
    validateManagementProfile(
      { ...legacy, address: "New address" },
      ["Admin"],
      legacy.qualification,
      legacy,
    ),
    "",
  );
  assert.match(
    validateManagementProfile(
      { ...legacy, email: "new invalid" },
      ["Admin"],
      legacy.qualification,
      legacy,
    ),
    /Enter a valid email address/,
  );
  const { ProfileDetails } = await import("../src/components/StaffProfile.jsx");
  const saved = renderToStaticMarkup(
    createElement(ProfileDetails, { account: staff[0], profile: legacy }),
  );
  assert.match(saved, /000 placeholder/);
  assert.match(saved, /legacy invalid number \(Lebanon\)/);
  const international = renderToStaticMarkup(
    createElement(ProfileDetails, {
      account: staff[0],
      profile: { ...legacy, phone: "+12133734253", phoneCountry: "US" },
    }),
  );
  assert.match(international, /Phone — unverified \(United States\)/);
  assert.doesNotMatch(international, /legacy invalid number/);
});
