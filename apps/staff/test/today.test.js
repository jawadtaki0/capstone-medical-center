import test from "node:test";
import assert from "node:assert/strict";
import {
  startSummaryRefresh,
  todayCards,
} from "../src/lib/operationalSummary.js";

test("summary refresh uses ten-second local reads without overlapping work or reporting activity", async () => {
  let tick,
    finish,
    reads = 0,
    values = [];
  const poll = startSummaryRefresh({
    read: () => {
      reads++;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
    current: () => true,
    onValue: (value) => values.push(value),
    onError: assert.fail,
    schedule: (fn, milliseconds) => {
      assert.equal(milliseconds, 10000);
      tick = fn;
      return 7;
    },
    unschedule: (id) => assert.equal(id, 7),
  });
  await tick();
  await poll.refresh();
  assert.equal(reads, 1);
  finish({ count: 3 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(values, [{ count: 3 }]);
  poll.stop();
  await tick();
  assert.equal(reads, 1);
});

test("visible authorized intake refresh pauses hidden/expired work and discards a delayed result after access loss", async () => {
  let visible = false,
    authorized = true,
    tick,
    reads = 0,
    synced = 0,
    finish;
  const poll = startSummaryRefresh({
    current: () => visible && authorized,
    read: () => {
      reads++;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
    onValue: () => synced++,
    onError: assert.fail,
    schedule: (callback, delay) => {
      assert.equal(delay, 10000);
      tick = callback;
      return 1;
    },
    unschedule() {},
  });
  await tick();
  assert.equal(reads, 0);
  visible = true;
  void poll.refresh();
  await tick();
  assert.equal(reads, 1);
  authorized = false;
  finish({ refreshed: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(synced, 0);
  await tick();
  assert.equal(reads, 1);
  poll.stop();
});

test("delayed summary responses cannot restore metadata after expiry or unmount", async () => {
  for (const stop of [false, true]) {
    let current = true,
      finish,
      values = 0;
    const poll = startSummaryRefresh({
      read: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      current: () => current,
      onValue: () => values++,
      onError: assert.fail,
      schedule: () => 1,
      unschedule: () => {},
    });
    if (stop) poll.stop();
    else current = false;
    finish({ private: "must-not-return" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(values, 0);
    poll.stop();
  }
});

test("transient failures retain retry ability while revoked authority prevents later callbacks", async () => {
  let failed = 0,
    value = 0,
    current = true,
    read = 0;
  const poll = startSummaryRefresh({
    read: async () => {
      if (++read === 1) throw Error("unavailable");
      return {};
    },
    current: () => current,
    onValue: () => value++,
    onError: () => failed++,
    schedule: () => 1,
    unschedule: () => {},
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(failed, 1);
  await poll.refresh();
  assert.equal(value, 1);
  current = false;
  await poll.refresh();
  assert.equal(read, 2);
  poll.stop();
});

test("Today cards use server capability combinations without role guesses or duplicate cards", () => {
  assert.deepEqual(todayCards({ capabilities: {} }), []);
  const lab = todayCards({
    capabilities: { patients: true, serviceHours: true, schedules: true },
    counts: { unpublishedChanges: 2 },
  });
  assert.equal(
    lab.some(
      (c) =>
        c.id === "new-booking" ||
        c.id === "requests" ||
        c.id === "professionals",
    ),
    false,
  );
  const mixed = todayCards({
    capabilities: {
      book: true,
      bookingView: true,
      patients: true,
      requests: true,
      professionals: true,
      schedules: true,
      directory: true,
      centerSettings: true,
    },
    counts: {
      requestsAwaitingDecision: 3,
      messagesToSend: 2,
      todayBookings: 1,
      unpublishedChanges: 0,
    },
  });
  assert.equal(new Set(mixed.map((c) => c.id)).size, mixed.length);
  assert.deepEqual(mixed.find((c) => c.id === "messages").target, {
    view: "requests",
    tab: "messages",
  });
  assert.equal(mixed.find((c) => c.id === "requests").count, 3);
});
