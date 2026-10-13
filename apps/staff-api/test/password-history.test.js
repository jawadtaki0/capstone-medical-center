import assert from "node:assert/strict";
import { test } from "node:test";
import * as argon2 from "argon2";
import { checkRecordedPasswords } from "../src/password-history.js";

test("shared history checks current and every old hash sequentially and closes the cursor", async () => {
  const old = await argon2.hash("a dummy old passphrase", {
    memoryCost: 19456,
    timeCost: 2,
  });
  const current = await argon2.hash("a dummy current passphrase", {
    memoryCost: 19456,
    timeCost: 2,
  });
  let checks = 0,
    closed = false;
  const cursor = {
    async *[Symbol.asyncIterator]() {
      for (let version = 1; version <= 20; version++)
        yield { credentialVersion: version, hashCipher: old };
    },
    async close() {
      closed = true;
    },
  };
  assert.equal(
    await checkRecordedPasswords({
      password: "a dummy old passphrase",
      currentHash: current,
      cursor,
      vault: { decrypt: (value) => value },
      check: async () => {
        checks++;
      },
      work: async (_stage, operation) => operation(),
    }),
    true,
  );
  assert.equal(closed, true);
  assert.ok(checks >= 2);
});

test("history corruption fails closed and closes the cursor", async () => {
  let closed = false;
  const cursor = {
    async *[Symbol.asyncIterator]() {
      yield { credentialVersion: 1, hashCipher: "not a hash" };
    },
    async close() {
      closed = true;
    },
  };
  await assert.rejects(
    checkRecordedPasswords({
      password: "dummy",
      currentHash: "unused",
      cursor,
      vault: { decrypt: (value) => value },
      check: async () => {},
      work: async (stage) => (stage === "history-current" ? false : true),
    }),
  );
  assert.equal(closed, true);
});
