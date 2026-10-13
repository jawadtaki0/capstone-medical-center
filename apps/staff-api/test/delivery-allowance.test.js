import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import * as delivery from "../src/contact-delivery.js";
import { allowanceIncreaseInput } from "../scripts/configure-delivery.js";

const request = (overrides = {}) => ({
  expectedAllowance: 5,
  newAllowance: 9,
  confirmation: "INCREASE 5 TO 9",
  ...overrides,
});
const settings = () => ({
  version: 2,
  provider: "gmail",
  sender: "synthetic.sender@gmail.com",
  appPassword: "SyntheticOnly123",
  enabled: true,
  deliveryScope: "staff_self_service",
  allowance: 5,
  approvalId: randomUUID(),
  retainedSetting: "preserve unknown compatibility metadata",
});
async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), "capstone-allowance-test-"));
  // Deliberately fake wrapping only inside this owned synthetic file fixture.
  // No SMTP, account, database or actual protected runtime is accessed.
  const options = { directory, wrap: async (v) => v, unwrap: async (v) => v };
  const original = settings();
  await writeFile(join(directory, "gmail.dpapi"), JSON.stringify(original));
  try {
    await run({ directory, options, original });
  } finally {
    assert.ok(directory.startsWith(join(tmpdir(), "capstone-allowance-test-")));
    await rm(directory, { recursive: true, force: true });
  }
}

test("allowance increase preserves every setting, budget identity and unrelated usage bytes", async () => {
  await fixture(async ({ directory, options, original }) => {
    const usage = Buffer.from('{"used":5,"monthlyCeiling":20}');
    await writeFile(join(directory, "synthetic-usage.json"), usage);
    const result = await delivery.increaseDeliveryAllowance(request(), options);
    const after = JSON.parse(await readFile(join(directory, "gmail.dpapi")));
    assert.deepEqual(after, { ...original, allowance: 9 });
    assert.deepEqual(result, { previousAllowance: 5, allowance: 9 });
    assert.deepEqual(
      await readFile(join(directory, "synthetic-usage.json")),
      usage,
    );
    assert.deepEqual((await readdir(directory)).sort(), [
      "gmail.dpapi",
      "synthetic-usage.json",
    ]);
  });
});

test("invalid, unconfirmed, decreasing, reset and over-ceiling requests leave bytes untouched", async () => {
  await fixture(async ({ directory, options }) => {
    const before = await readFile(join(directory, "gmail.dpapi"));
    for (const input of [
      request({ confirmation: undefined }),
      request({ confirmation: "yes" }),
      request({ newAllowance: 4, confirmation: "INCREASE 5 TO 4" }),
      request({ newAllowance: 5, confirmation: "INCREASE 5 TO 5" }),
      request({ newAllowance: 21, confirmation: "INCREASE 5 TO 21" }),
      request({ newAllowance: 9.5 }),
      request({ newAllowance: "9" }),
      request({ expectedAllowance: 0 }),
      request({ attempts: 0 }),
      request({ approvalId: randomUUID() }),
      request({ enabled: false }),
    ]) {
      await assert.rejects(delivery.increaseDeliveryAllowance(input, options));
      assert.deepEqual(await readFile(join(directory, "gmail.dpapi")), before);
    }
  });
});

test("stale expectation and repeated increase do not overwrite current settings", async () => {
  await fixture(async ({ directory, options }) => {
    await delivery.increaseDeliveryAllowance(request(), options);
    const before = await readFile(join(directory, "gmail.dpapi"));
    await assert.rejects(
      delivery.increaseDeliveryAllowance(request(), options),
      /changed/i,
    );
    assert.deepEqual(await readFile(join(directory, "gmail.dpapi")), before);
  });
});

test("concurrent increases admit one writer and preserve credentials and usage identity", async () => {
  await fixture(async ({ directory, options, original }) => {
    const results = await Promise.allSettled([
      delivery.increaseDeliveryAllowance(request(), options),
      delivery.increaseDeliveryAllowance(
        request({ newAllowance: 10, confirmation: "INCREASE 5 TO 10" }),
        options,
      ),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(results.filter((r) => r.status === "rejected").length, 1);
    const after = JSON.parse(await readFile(join(directory, "gmail.dpapi")));
    assert.ok([9, 10].includes(after.allowance));
    assert.deepEqual({ ...after, allowance: 5 }, original);
    assert.deepEqual(await readdir(directory), ["gmail.dpapi"]);
  });
});

test("stale credential or activation writer cannot undo an allowance increase", async () => {
  await fixture(async ({ directory, options, original }) => {
    const expectedConfig = delivery.validateDeliveryConfig(original);
    await delivery.increaseDeliveryAllowance(request(), options);
    const before = await readFile(join(directory, "gmail.dpapi"));
    await assert.rejects(
      delivery.saveDeliveryConfig(
        { ...expectedConfig, enabled: false },
        {
          ...options,
          prepare: async () => {},
          expectedConfig,
        },
      ),
      /changed/i,
    );
    assert.deepEqual(await readFile(join(directory, "gmail.dpapi")), before);
  });
});

test("failed wrapping, unreadable settings and stale lock never replace the protected file", async () => {
  await fixture(async ({ directory, options }) => {
    const before = await readFile(join(directory, "gmail.dpapi"));
    await assert.rejects(
      delivery.increaseDeliveryAllowance(request(), {
        ...options,
        wrap: async () => {
          throw new Error("Synthetic wrapping failure");
        },
      }),
    );
    assert.deepEqual(await readFile(join(directory, "gmail.dpapi")), before);
    await assert.rejects(
      delivery.increaseDeliveryAllowance(request(), {
        ...options,
        unwrap: async () => Buffer.from("not JSON"),
      }),
    );
    assert.deepEqual(await readFile(join(directory, "gmail.dpapi")), before);
    await writeFile(join(directory, "gmail.lock"), "owned synthetic lock");
    await assert.rejects(
      delivery.increaseDeliveryAllowance(request(), options),
    );
    assert.deepEqual(await readFile(join(directory, "gmail.dpapi")), before);
    assert.equal(
      await readFile(join(directory, "gmail.lock"), "utf8"),
      "owned synthetic lock",
    );
  });
});

test("legacy and disabled settings keep activation and compatibility fields unchanged", async () => {
  await fixture(async ({ directory, options, original }) => {
    const legacy = {
      ...original,
      version: 1,
      enabled: false,
      recipients: ["synthetic@example.invalid"],
    };
    delete legacy.deliveryScope;
    await writeFile(join(directory, "gmail.dpapi"), JSON.stringify(legacy));
    await delivery.increaseDeliveryAllowance(request(), options);
    assert.deepEqual(
      JSON.parse(await readFile(join(directory, "gmail.dpapi"))),
      { ...legacy, allowance: 9 },
    );
  });
});

test("private operator arguments require exact explicit confirmation and reject mixed actions", () => {
  const args = [
    "--demo-loopback",
    "--increase-allowance",
    "9",
    "--expected-allowance",
    "5",
    "--confirm-increase",
    "INCREASE 5 TO 9",
  ];
  assert.deepEqual(allowanceIncreaseInput(args), request());
  for (const values of [
    args.slice(0, -2),
    [...args, "--enable-self-service"],
    [...args, "--reset-usage"],
    [...args, "--increase-allowance", "10"],
    args.map((v) => (v === "9" ? "9.5" : v)),
  ])
    assert.throws(() => allowanceIncreaseInput(values));
  assert.equal(allowanceIncreaseInput(["--demo-loopback"]), null);
});

test("ceiling total 20 is accepted without enabling disabled delivery", async () => {
  await fixture(async ({ directory, options, original }) => {
    const disabled = { ...original, enabled: false };
    await writeFile(join(directory, "gmail.dpapi"), JSON.stringify(disabled));
    await delivery.increaseDeliveryAllowance(
      request({ newAllowance: 20, confirmation: "INCREASE 5 TO 20" }),
      options,
    );
    assert.deepEqual(
      JSON.parse(await readFile(join(directory, "gmail.dpapi"))),
      { ...disabled, allowance: 20 },
    );
  });
});

test("absent existing budget authority is never recreated or assigned a new identity", async () => {
  await fixture(async ({ directory, options, original }) => {
    const absent = {
      ...original,
      enabled: false,
      allowance: 0,
      approvalId: null,
    };
    await writeFile(join(directory, "gmail.dpapi"), JSON.stringify(absent));
    const before = await readFile(join(directory, "gmail.dpapi"));
    await assert.rejects(
      delivery.increaseDeliveryAllowance(request(), options),
      /existing approved budget/i,
    );
    assert.deepEqual(await readFile(join(directory, "gmail.dpapi")), before);
  });
});

test("two real private operator processes preserve DPAPI configuration and admit one confirmed increase", async () => {
  const runtime = await mkdtemp(
    join(tmpdir(), "capstone-allowance-operator-test-"),
  );
  const directory = join(runtime, "delivery");
  const execute = promisify(execFile);
  const tool = fileURLToPath(
    new URL("../scripts/configure-delivery.js", import.meta.url),
  );
  const original = delivery.validateDeliveryConfig(settings());
  try {
    // Presence marker only, inside this owned fixture; no real authority/key.
    await writeFile(
      join(runtime, "authority.dpapi"),
      "Synthetic presence marker",
    );
    await delivery.saveDeliveryConfig(original, { directory });
    const usage = Buffer.from('{"used":5,"monthlyCeiling":20}');
    await writeFile(join(runtime, "synthetic-usage.json"), usage);
    const run = (total) =>
      execute(
        process.execPath,
        [
          tool,
          "--demo-loopback",
          "--increase-allowance",
          String(total),
          "--expected-allowance",
          "5",
          "--confirm-increase",
          `INCREASE 5 TO ${total}`,
        ],
        {
          windowsHide: true,
          timeout: 30000,
          maxBuffer: 4096,
          env: { ...process.env, CAPSTONE_STAFF_RUNTIME_DIR: runtime },
        },
      );
    const results = await Promise.allSettled([run(9), run(10)]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(results.filter((r) => r.status === "rejected").length, 1);
    const after = await delivery.loadDeliveryConfig({ directory });
    assert.ok([9, 10].includes(after.allowance));
    assert.deepEqual({ ...after, allowance: 5 }, original);
    assert.deepEqual(
      await readFile(join(runtime, "synthetic-usage.json")),
      usage,
    );
    const bytes = await readFile(join(directory, "gmail.dpapi"));
    assert.equal(bytes.includes(Buffer.from(original.appPassword)), false);
    assert.equal(bytes.includes(Buffer.from(original.sender)), false);
    for (const result of results) {
      const output =
        result.status === "fulfilled"
          ? result.value.stdout
          : result.reason.stderr;
      assert.doesNotMatch(
        output,
        new RegExp(
          `${original.appPassword}|${original.sender}|${original.approvalId}`,
        ),
      );
    }
    const before = await readFile(join(directory, "gmail.dpapi"));
    await assert.rejects(run(9));
    assert.deepEqual(await readFile(join(directory, "gmail.dpapi")), before);
    assert.deepEqual(await readdir(directory), ["gmail.dpapi"]);
  } finally {
    assert.ok(
      runtime.startsWith(join(tmpdir(), "capstone-allowance-operator-test-")),
    );
    await rm(runtime, { recursive: true, force: true });
  }
});
