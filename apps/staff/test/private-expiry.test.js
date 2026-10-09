import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { observeChallenge, sessionTiming } from "../src/lib/activity.js";
import { loadPrivateEnrollment } from "../src/lib/privateEnrollment.js";

const challenge = {
  serverNow: "2026-10-09T08:00:00.000Z",
  expiresAt: "2026-10-09T08:10:00.000Z",
};

test("capture deadline checks are read-only until expiry and cannot redraw controlled input", async () => {
  const source = await readFile(
    new URL("../src/App.jsx", import.meta.url),
    "utf8",
  );
  assert.ok(
    source.includes("const checkDeadline = () => isAccessCurrent(current);"),
  );
  assert.match(source, /document\.addEventListener\(type, checkDeadline,\s*\{/);
  assert.match(source, /setInterval\(refreshClock, 1000\)/);
  assert.match(source, /window\.addEventListener\("focus", refreshClock\)/);
});

test("private enrollment uses the server deadline and rejects delayed responses", () => {
  const observed = observeChallenge(challenge, 1000);
  assert.equal(sessionTiming(observed, 1000).secondsRemaining, 600);
  assert.equal(sessionTiming(observed, 601000).expired, true);
  // Anchor at request start, not receipt: delayed responses cannot renew access.
  assert.equal(sessionTiming(observed, 602000).expired, true);
  assert.equal(observed.idleExpiresAt, challenge.expiresAt);
  assert.equal(observed.absoluteExpiresAt, challenge.expiresAt);
});

test("private deadlines fail closed with missing/malformed server metadata", () => {
  for (const data of [
    null,
    {},
    { ...challenge, serverNow: "invalid" },
    { ...challenge, expiresAt: "invalid" },
  ]) {
    assert.equal(sessionTiming(observeChallenge(data, 0), 0).expired, true);
  }
});

test("suspension is checked against elapsed time, not a count of interval ticks", () => {
  const observed = observeChallenge(challenge, 3000);
  // No simulated ticks occur during this gap.
  assert.equal(sessionTiming(observed, 3000 + 600000).expired, true);
  assert.equal(sessionTiming(observed, 3000 + 3600000).expired, true);
});

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
for (const boundary of ["enrollment", "QR"]) {
  for (const reason of ["deadline", "cancellation"]) {
    test(`delayed ${boundary} cannot restore private displays after ${reason}`, async () => {
      const pending = deferred();
      const shown = [];
      let now = 0;
      let generation = 1;
      const observed = observeChallenge(challenge, 0);
      const running = loadPrivateEnrollment({
        load: () =>
          boundary === "enrollment"
            ? pending.promise
            : Promise.resolve({
                secret: "dummy-seed",
                otpauthUri: "dummy-uri",
              }),
        renderQr: () =>
          boundary === "QR" ? pending.promise : Promise.resolve("dummy-QR"),
        isCurrent: () =>
          generation === 1 && !sessionTiming(observed, now).expired,
        onSeed: (value) => shown.push(value),
        onQr: (value) => shown.push(value),
        onQrUnavailable: () => shown.push("QR-unavailable"),
      });
      // Let the first await settle so QR cases pause at the second boundary.
      await Promise.resolve();
      await Promise.resolve();
      if (reason === "deadline") now = 600000;
      else generation += 1;
      shown.length = 0; // Parent unmount removes the previously displayed seed.
      pending.resolve(
        boundary === "QR"
          ? "dummy-QR"
          : { secret: "dummy-seed", otpauthUri: "dummy-uri" },
      );
      await running;
      assert.deepEqual(shown, []);
    });
  }
}

test("current enrollment renders, while current QR failure preserves manual enrollment", async () => {
  for (const failQr of [false, true]) {
    const shown = [];
    await loadPrivateEnrollment({
      load: async () => ({ secret: "dummy-seed", otpauthUri: "dummy-uri" }),
      renderQr: async () => {
        if (failQr) throw new Error("dummy render failure");
        return "dummy-QR";
      },
      isCurrent: () => true,
      onSeed: (value) => shown.push(value),
      onQr: (value) => shown.push(value),
      onQrUnavailable: () => shown.push("QR-unavailable"),
    });
    assert.deepEqual(shown, [
      "dummy-seed",
      failQr ? "QR-unavailable" : "dummy-QR",
    ]);
  }
});
