import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  avatarSheet,
  avatarState,
  normalizeAvatarVariant,
} from "../src/data/professionalAvatars.js";
import { professionalName } from "../src/data/professionalNames.js";
import { filterProfessionals } from "../src/lib/directory.js";

test("public male and female avatar variants select the original supplied artwork", () => {
  for (const variant of ["male", "female"]) {
    assert.equal(normalizeAvatarVariant(variant), variant);
    assert.deepEqual(avatarState(variant), { variant, state: "supplied" });
  }
  assert.ok(existsSync(new URL(avatarSheet)));
});

test("neutral or unknown variants never guess from profile IDs, names, specialties or initials", () => {
  for (const value of [
    "neutral",
    "test:doctor:example",
    "Dr. Example",
    "Gynecology",
    "DS",
    "unknown",
    "toString",
    undefined,
    null,
    {},
    42,
  ]) {
    assert.equal(normalizeAvatarVariant(value), "neutral");
    assert.deepEqual(avatarState(value), {
      variant: "neutral",
      state: "neutral",
    });
  }
});

test("failed artwork uses an unavailable fallback without replacing the server's variant", () => {
  for (const variant of ["male", "female"]) {
    assert.deepEqual(avatarState(variant, true), {
      variant,
      state: "unavailable",
    });
  }
  assert.deepEqual(avatarState("neutral", true), {
    variant: "neutral",
    state: "neutral",
  });
});

test("Mkahhel is a display correction with both spellings searchable and no stored mutation", () => {
  const original = {
    id: "cedar:specialist:zeinab-makahhel",
    name: "Zeinab Makahhel",
    specialty: "Speech, Language, and Swallowing Therapist",
    kind: "specialist",
  };
  assert.equal(professionalName(original.name), "Zeinab Mkahhel");
  assert.equal(professionalName("Other Professional"), "Other Professional");
  assert.deepEqual(filterProfessionals([original], "mkahhel"), [original]);
  assert.deepEqual(filterProfessionals([original], "makahhel"), [original]);
  assert.equal(original.name, "Zeinab Makahhel");
});
