import assert from "node:assert/strict";
import { test } from "node:test";
import {
  launchStaff,
  terminateCapturedChild,
} from "../scripts/launcher/orchestrator.js";

function fixture(states = ["absent", "absent"], overrides = {}) {
  const events = [];
  let time = 0;
  const controller = new AbortController();
  const services = states.map((initial, index) => {
    let state = initial;
    return {
      name: index === 0 ? "database" : "staff server",
      async probe() {
        return state;
      },
      async start() {
        events.push(`start:${index}`);
        if (overrides.startFails === index)
          throw new Error("dummy private error");
        state = overrides.neverReady === index ? "waiting" : "ready";
        return {
          async stop() {
            events.push(`stop:${index}`);
          },
          async prepareRelease() {
            events.push(`release:${index}`);
            if (overrides.releaseFails === index)
              throw new Error("dummy private error");
          },
          detach() {
            events.push(`detach:${index}`);
          },
          async commitRelease() {
            events.push(`commit:${index}`);
            if (overrides.commitFails === index)
              throw new Error("dummy private error");
          },
        };
      },
    };
  });
  const options = {
    services,
    signal: controller.signal,
    clock: () => time,
    timeoutMs: 10,
    sleep: async () => {
      time += 5;
      if (overrides.cancel) controller.abort();
    },
    preflight: async () => {
      events.push("preflight");
      if (overrides.missing)
        throw new Error("Packaged application is missing.");
    },
    lock: async () => {
      events.push("lock");
      if (overrides.locked) throw new Error("Startup is already in progress.");
      return async () => {
        events.push("unlock");
      };
    },
    openApp: async () => {
      events.push("app");
      if (overrides.appFails)
        throw new Error("Packaged application could not start.");
    },
    progress: (value) => {
      events.push(value);
    },
  };
  return { options, events, controller };
}

test("bounded last-resort cleanup uses only the live captured child, never an exited or absent child", () => {
  let kills = 0;
  const child = { exitCode: null, signalCode: null, kill: () => kills++ };
  terminateCapturedChild(child);
  assert.equal(kills, 1);
  terminateCapturedChild({ ...child, exitCode: 0 });
  terminateCapturedChild({ ...child, signalCode: "SIGTERM" });
  terminateCapturedChild(undefined);
  assert.equal(kills, 1);
});

for (const states of [
  ["absent", "absent"],
  ["ready", "absent"],
  ["absent", "ready"],
  ["ready", "ready"],
]) {
  test(`startup reuses healthy services ${states.join("/")} and detaches only its children`, async () => {
    const { options, events } = fixture(states);
    await launchStaff(options);
    assert.equal(events.filter((event) => event === "app").length, 1);
    states.forEach((state, index) => {
      assert.equal(events.includes(`start:${index}`), state === "absent");
      assert.equal(events.includes(`detach:${index}`), state === "absent");
    });
    assert.equal(
      events.some((event) => event.startsWith("stop:")),
      false,
    );
    assert.ok(events.indexOf("app") > events.indexOf("Checking staff server"));
    assert.equal(events.at(-1), "unlock");
  });
}

for (const index of [0, 1]) {
  test(`unexpected port ${index} is refused; reused services are never stopped`, async () => {
    const states = ["ready", "ready"];
    states[index] = "unexpected";
    const { options, events } = fixture(states);
    await assert.rejects(launchStaff(options), /unexpected service/i);
    assert.equal(
      events.some((event) => /^(start|stop|app)/.test(event)),
      false,
    );
  });
}

test("missing application fails before any service is touched", async () => {
  const { options, events } = fixture(undefined, { missing: true });
  await assert.rejects(launchStaff(options), /missing/);
  assert.deepEqual(events, ["preflight"]);
});
test("simultaneous startup lock refuses a second attempt before starting services", async () => {
  const { options, events } = fixture(undefined, { locked: true });
  await assert.rejects(launchStaff(options), /already in progress/);
  assert.equal(
    events.some((event) => event.startsWith("start:")),
    false,
  );
});
test("database startup timeout cleans up only the owned database", async () => {
  const { options, events } = fixture(undefined, { neverReady: 0 });
  await assert.rejects(launchStaff(options), /database.*ready/i);
  assert.deepEqual(
    events.filter((event) => event.startsWith("stop:")),
    ["stop:0"],
  );
  assert.equal(events.includes("app"), false);
});
test("API timeout cleans partial startup in reverse order", async () => {
  const { options, events } = fixture(undefined, { neverReady: 1 });
  await assert.rejects(launchStaff(options), /staff server.*ready/i);
  assert.deepEqual(
    events.filter((event) => event.startsWith("stop:")),
    ["stop:1", "stop:0"],
  );
});
test("a waiting existing database times out without being restarted or stopped", async () => {
  const { options, events } = fixture(["waiting", "ready"]);
  await assert.rejects(launchStaff(options), /database.*ready/i);
  assert.equal(
    events.some((event) => /^(start|stop|app)/.test(event)),
    false,
  );
});
test("API spawn failure cleans owned database, with safe error text", async () => {
  const { options, events } = fixture(undefined, { startFails: 1 });
  await assert.rejects(
    launchStaff(options),
    (error) => !error.message.includes("private"),
  );
  assert.deepEqual(
    events.filter((event) => event.startsWith("stop:")),
    ["stop:0"],
  );
});
test("cancellation during readiness cleans owned services only", async () => {
  const { options, events } = fixture(["ready", "absent"], {
    neverReady: 1,
    cancel: true,
  });
  await assert.rejects(launchStaff(options), /cancelled/i);
  assert.deepEqual(
    events.filter((event) => event.startsWith("stop:")),
    ["stop:1"],
  );
});
test("cancellation before startup does not acquire the lock or open anything", async () => {
  const { options, events, controller } = fixture();
  controller.abort();
  await assert.rejects(launchStaff(options), /cancelled/i);
  assert.equal(events.includes("lock"), false);
});
test("application opening failure cleans both owned services", async () => {
  const { options, events } = fixture(undefined, { appFails: true });
  await assert.rejects(launchStaff(options), /application.*start/i);
  assert.deepEqual(
    events.filter((event) => event.startsWith("stop:")),
    ["stop:1", "stop:0"],
  );
});
test("handoff failure stops both children before any detach", async () => {
  const { options, events } = fixture(undefined, { releaseFails: 1 });
  await assert.rejects(launchStaff(options), /handoff/i);
  assert.equal(
    events.some((event) => event.startsWith("detach:")),
    false,
  );
  assert.deepEqual(
    events.filter((event) => event.startsWith("stop:")),
    ["stop:1", "stop:0"],
  );
});
test("repeated successful startup reuses services without stopping them", async () => {
  const { options, events } = fixture();
  await launchStaff(options);
  await launchStaff(options);
  assert.equal(events.filter((event) => event.startsWith("start:")).length, 2);
  assert.equal(events.filter((event) => event === "app").length, 2);
  assert.equal(
    events.some((event) => event.startsWith("stop:")),
    false,
  );
});

test("a delayed ready reply cannot bypass the startup deadline", async () => {
  const { options, events } = fixture(["ready", "ready"]);
  let time = 0;
  options.clock = () => time;
  options.services[0].probe = async () => {
    time = 11;
    return "ready";
  };
  await assert.rejects(launchStaff(options), /database.*startup limit/i);
  assert.equal(events.includes("app"), false);
});

test("cleanup failure is explicit and other owned children still get cleanup", async () => {
  const { options, events } = fixture(undefined, { appFails: true });
  const start = options.services[1].start;
  options.services[1].start = async () => {
    const child = await start();
    child.stop = async () => {
      throw new Error("dummy secret");
    };
    return child;
  };
  await assert.rejects(launchStaff(options), /bounded shutdown/);
  assert.equal(events.includes("stop:0"), true);
  assert.equal(events.at(-1), "unlock");
});

test("commit acknowledgement failure cleans all owned children without premature disconnect", async () => {
  const { options, events } = fixture(undefined, { commitFails: 1 });
  await assert.rejects(launchStaff(options), /handoff.*commit/i);
  assert.equal(
    events.some((event) => event.startsWith("detach:")),
    false,
  );
  assert.deepEqual(
    events.filter((event) => event.startsWith("stop:")),
    ["stop:1", "stop:0"],
  );
});
