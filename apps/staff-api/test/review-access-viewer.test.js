import test from "node:test";
import assert from "node:assert/strict";
import { generate } from "otplib";
import {
  buildReviewAccessOptions,
  currentReviewCode,
} from "../../staff/scripts/private-review-access.js";

const saved = {
  version: 1,
  syntheticOnly: true,
  admin: {
    username: "synthetic.admin",
    password: "DUMMY-PASSWORD",
    secret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
    backupCodes: ["DUMMY-BACKUP-A", "DUMMY-BACKUP-B"],
  },
  receptionist: {
    username: "synthetic.reception",
    password: "DUMMY-RECEPTION-PASSWORD",
  },
};
test("review-only fields distinguish current code, setup key and individually copyable initial backup codes", async () => {
  const now = Date.parse("2026-10-30T12:00:12Z"),
    options = await buildReviewAccessOptions(saved, { now });
  assert.equal(options.purpose, "hosted-review");
  assert.equal(options.reviewDisplay, true);
  assert(options.fields.every((f) => f.readOnly && f.copyValue));
  assert.equal(options.fields.filter((f) => f.currentCode).length, 1);
  assert.equal(
    options.fields.filter((f) => f.label.startsWith("Initial backup code"))
      .length,
    2,
  );
  assert.match(options.note, /consumed backup codes remain invalid/i);
  assert(options.fields.find((f) => f.currentCode).initialVisible);
  assert(
    !options.fields.find((f) => f.label === "Authenticator setup key")
      .initialVisible,
  );
  assert.equal(Object.hasOwn(saved.admin, "history"), false);
  const current = currentReviewCode(options.reviewCodePeriods, now);
  const expected = await generate({
    secret: saved.admin.secret,
    epoch: Math.floor(now / 1000),
    period: 30,
    digits: 6,
  });
  assert.ok(
    current.code === expected,
    "display uses the same TOTP library/settings as sign-in",
  );
  assert.equal(current.validUntil, "2026-10-30T12:00:30.000Z");
  const next = currentReviewCode(
    options.reviewCodePeriods,
    Date.parse(current.validUntil),
  );
  assert.ok(next && next.validFrom === current.validUntil);
  assert.equal(
    currentReviewCode(options.reviewCodePeriods, Date.parse(options.expiresAt)),
    null,
  );
  assert.equal(
    currentReviewCode(options.reviewCodePeriods, now + 3600000),
    null,
    "suspension cannot restore expired codes",
  );
});
test("normal or malformed access sheets are refused without printing their values", async () => {
  for (const value of [
    { ...saved, syntheticOnly: false },
    { ...saved, version: 2 },
    { ...saved, admin: { ...saved.admin, secret: null } },
  ])
    await assert.rejects(
      buildReviewAccessOptions(value),
      (e) =>
        !e.message.includes(saved.admin.password) &&
        !e.message.includes(saved.admin.secret),
    );
});
