import assert from "node:assert/strict";
import test from "node:test";
import { contactStatus } from "../src/contact-status.js";
const vault = { contactDigest: (value) => `synthetic-digest:${value}` };
test("current emailVerification proof is authoritative, not the legacy boolean", () => {
  const email = "synthetic@example.invalid";
  const proof = {
    verifiedAt: new Date(),
    method: "email_code",
    provider: "gmail",
    mode: "live",
    valueDigest: vault.contactDigest(email),
  };
  assert.equal(
    contactStatus(
      { email, emailVerified: false, emailVerification: proof },
      vault,
    ).email,
    "verified",
  );
  assert.equal(
    contactStatus({ email, emailVerified: true }, vault).email,
    "unverified",
  );
  assert.equal(
    contactStatus(
      {
        email,
        emailVerified: true,
        emailVerification: { ...proof, valueDigest: "different" },
      },
      vault,
    ).email,
    "unverified",
  );
  assert.equal(
    contactStatus(
      { email, emailVerification: { ...proof, mode: "test" } },
      vault,
    ).email,
    "test_only",
  );
  for (const releasedAt of [new Date(), null, "invalid historical marker"]) {
    assert.equal(
      contactStatus(
        { email, emailVerification: { ...proof, releasedAt } },
        vault,
      ).email,
      "released",
    );
  }
  assert.equal(
    contactStatus(
      { email, emailVerification: { ...proof, provider: "unknown" } },
      vault,
    ).email,
    "unverified",
  );
  assert.equal(
    contactStatus(
      { email, emailVerification: { ...proof, verifiedAt: "invalid" } },
      vault,
    ).email,
    "unverified",
  );
});
