import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizedEmail,
  canonicalPhone,
  savedLebanesePhone,
  savedPhone,
  PHONE_COUNTRIES,
  phoneExample,
  EMAIL_INPUT_MESSAGE,
} from "../../staff/shared/contact-input.js";
import { normalizeEmail } from "../src/contact-delivery.js";
import {
  validateCreate,
  validateManagementProfile,
} from "../src/management-validation.js";
import { validateProfile } from "../src/validation.js";
import { syntheticProfile } from "./helpers/security-fixture.js";

test("shared email syntax accepts public-style suffixes and plus but not malformed or multiple addresses", () => {
  for (const value of [
    "person+clinic@example.com",
    "person@example.org",
    "person@example.edu",
    " person@center.com.lb ",
    "name@sub-domain.example.technology",
  ])
    assert.equal(normalizeEmail(value), normalizedEmail(value));
  for (const value of [
    "",
    "@example.com",
    "name@",
    "a@localhost",
    "a b@example.com",
    "a@exa mple.com",
    "a@example.com,b@example.com",
    "a@@example.com",
    "a@-bad.com",
    "a@bad-.com",
    "a@bad..com",
    "a@bad_label.com",
    ".a@example.com",
    "a..b@example.com",
    "a@example.123",
    "a@example.com\nBcc:b@example.com",
  ]) {
    assert.equal(normalizedEmail(value), null, value);
    assert.throws(() => normalizeEmail(value), {
      code: "invalid_input",
      message: EMAIL_INPUT_MESSAGE,
    });
  }
  assert.notEqual(
    normalizedEmail("name+tag@gmail.com"),
    normalizedEmail("name@gmail.com"),
  );
});
test("initial profile server paths share contact validation and canonicalize only new phone entries", () => {
  const profile = syntheticProfile({
    phone: "03-123456",
    qualification: {
      type: "university",
      level: "Bachelor",
      title: "Synthetic",
      institution: "Synthetic",
    },
  });
  assert.equal(validateProfile(profile).phone, "+9613123456");
  assert.equal(validateProfile(profile).phoneCountry, "LB");
  assert.equal(
    validateCreate(
      { username: "synthetic.new", roles: ["Admin"], profile },
      "2026-10-05",
    ).profile.phone,
    "+9613123456",
  );
  for (const email of ["a@localhost", "a@example..com", "a@-bad.com"]) {
    assert.throws(() => validateProfile({ ...profile, email }), {
      message: EMAIL_INPUT_MESSAGE,
    });
    assert.throws(
      () =>
        validateCreate(
          {
            username: "synthetic.new",
            roles: ["Admin"],
            profile: { ...profile, email },
          },
          "2026-10-05",
        ),
      { message: EMAIL_INPUT_MESSAGE },
    );
  }
  const legacy = { ...profile, phone: "+000000", email: "legacy@localhost" };
  const clean = validateManagementProfile(
    { ...legacy, address: "Updated only" },
    ["Admin"],
    "2026-10-05",
    { legacyQualification: legacy.qualification, legacyContacts: legacy },
  );
  assert.equal(clean.email, legacy.email);
  assert.equal(clean.phone, legacy.phone);
  const blankLegacy = { ...legacy, email: "", phone: "" };
  const unchanged = validateManagementProfile(
    { ...blankLegacy, address: "Different address" },
    ["Admin"],
    "2026-10-05",
    {
      legacyQualification: blankLegacy.qualification,
      legacyContacts: blankLegacy,
    },
  );
  assert.equal(unchanged.email, "");
  assert.equal(unchanged.phone, "");
  assert.throws(
    () =>
      validateCreate(
        { username: "synthetic.new", roles: ["Admin"], profile: blankLegacy },
        "2026-10-05",
      ),
    { message: EMAIL_INPUT_MESSAGE },
  );
});
test("metadata-driven phone parsing covers Lebanese zeros, international paste, selected countries and invalid placeholders", () => {
  for (const value of [
    "071123456",
    "71 123 456",
    "+961 71-123-456",
    "00961 71 123 456",
  ])
    assert.equal(canonicalPhone(value, "LB"), "+96171123456");
  assert.equal(canonicalPhone("03 123456", "LB"), "+9613123456");
  assert.equal(canonicalPhone("213 373 4253", "US"), "+12133734253");
  assert.equal(canonicalPhone("+44 20 7946 0018", "LB"), "+442079460018");
  for (const value of [
    "+000000000000",
    "12",
    "+96196171123456",
    "Call 71123456",
    "71123456 ext 5",
  ])
    assert.equal(canonicalPhone(value, "LB"), null);
  assert.equal(savedLebanesePhone("+12133734253").legacyInvalid, true);
  assert.equal(savedPhone({ phone: "+12133734253" }).legacyInvalid, true);
  assert.deepEqual(savedPhone({ phone: "+12133734253", phoneCountry: "US" }), {
    display: "+1 213 373 4253",
    legacyInvalid: false,
    countryName: "United States",
  });
  const raw = "+000000000000";
  assert.deepEqual(savedLebanesePhone(raw), {
    display: raw,
    legacyInvalid: true,
  });
  assert.ok(PHONE_COUNTRIES.includes("LB"));
  assert.ok(phoneExample("LB"));
});
