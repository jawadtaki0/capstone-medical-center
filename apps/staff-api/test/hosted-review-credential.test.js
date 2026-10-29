import assert from "node:assert/strict";
import test from "node:test";
import { configureHostedReviewCredential } from "../scripts/configure-hosted-review-credential.js";

function fixture(overrides = {}) {
  const calls = [];
  let plainReference;
  return {
    calls,
    get plainReference() {
      return plainReference;
    },
    options: {
      directory: "review-only",
      exists: async () => {
        throw Object.assign(new Error(), { code: "ENOENT" });
      },
      entry: async (options) => {
        calls.push(["entry", options]);
        return [
          "cedar_public_review",
          "capstone_public_review",
          "dummy-secret-only",
        ];
      },
      protect: async () => {
        calls.push(["protect"]);
      },
      encrypt: async (plain) => {
        plainReference = plain;
        assert.equal(
          JSON.parse(plain.toString()).password,
          "dummy-secret-only",
        );
        return Buffer.from("dummy-ciphertext");
      },
      save: async (path, value, options) => {
        calls.push(["save", path, value.toString(), options]);
      },
      ...overrides,
    },
  };
}

test("review credential is captured privately, encrypted, exclusive-written and buffer-cleared", async () => {
  const f = fixture();
  assert.deepEqual(await configureHostedReviewCredential(f.options), {
    status: "saved",
  });
  assert.equal(f.calls[0][1].purpose, "hosted-review");
  assert.equal(f.calls[0][1].fields[2].private, true);
  assert.equal(f.calls[2][2], "dummy-ciphertext");
  assert.equal(f.calls[2][3].flag, "wx");
  assert.ok(f.plainReference.every((byte) => byte === 0));
});

test("cancellation does not protect, encrypt or save", async () => {
  const f = fixture({ entry: async () => null });
  assert.deepEqual(await configureHostedReviewCredential(f.options), {
    status: "cancelled",
  });
  assert.equal(f.calls.length, 0);
});

test("existing credential refuses before asking for private entry", async () => {
  const f = fixture({ exists: async () => {} });
  await assert.rejects(configureHostedReviewCredential(f.options), /preserved/);
  assert.equal(f.calls.length, 0);
});

test("tampered fixed scope is rejected without a write", async () => {
  const f = fixture({
    entry: async () => ["normal-user", "medical-center-dev", "dummy"],
  });
  await assert.rejects(
    configureHostedReviewCredential(f.options),
    /Invalid review entry/,
  );
  assert.equal(f.calls.length, 0);
});

test("concurrent operator completion cannot overwrite the winner", async () => {
  let winner = false;
  const f = fixture({
    save: async () => {
      if (winner)
        throw Object.assign(new Error("already saved"), { code: "EEXIST" });
      winner = true;
    },
  });
  const results = await Promise.allSettled([
    configureHostedReviewCredential(f.options),
    configureHostedReviewCredential(f.options),
  ]);
  assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(results.filter((item) => item.status === "rejected").length, 1);
});

test("encryption failure clears the temporary buffer and never writes", async () => {
  let reference;
  const f = fixture({
    encrypt: async (plain) => {
      reference = plain;
      throw new Error("dummy failure");
    },
  });
  await assert.rejects(
    configureHostedReviewCredential(f.options),
    /dummy failure/,
  );
  assert.ok(reference.every((byte) => byte === 0));
  assert.equal(
    f.calls.some(([name]) => name === "save"),
    false,
  );
});
