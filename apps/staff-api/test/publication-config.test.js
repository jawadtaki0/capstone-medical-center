import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadPublicationConfig,
  provisionPublicationConfig,
  validatePublicationConfig,
} from "../src/publication-config.js";
import { assertPublicationStorage } from "../../../shared/publication-environment.mjs";
import { validateReceiverTarget } from "../src/publication-delivery.js";
import { parseTransitionArguments } from "../scripts/public-transition.js";
import { withPublicationOperatorLock } from "../src/publication-operator-lock.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

test("private config is opt-in, exclusive, validated and never rewrites existing credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cedar-publication-config-"));
  const protect = async () => {},
    wrap = async (bytes) => Buffer.from(bytes.toString("base64")),
    unwrap = async (bytes) => Buffer.from(bytes.toString(), "base64");
  try {
    assert.equal(await loadPublicationConfig({ directory, unwrap }), null);
    await assert.rejects(
      provisionPublicationConfig({ directory, protect, wrap }),
    );
    const value = await provisionPublicationConfig({
      directory,
      protect,
      wrap,
      publicSrvHost: "synthetic.mongodb.net",
      importDigest: "a".repeat(64),
      confirmed: true,
    });
    assert.deepEqual(await loadPublicationConfig({ directory, unwrap }), value);
    const before = await readFile(join(directory, "publication.dpapi"));
    await assert.rejects(
      provisionPublicationConfig({
        directory,
        protect,
        wrap,
        publicSrvHost: value.publicSrvHost,
        importDigest: value.importDigest,
        confirmed: true,
      }),
      { code: "EEXIST" },
    );
    assert.deepEqual(
      await readFile(join(directory, "publication.dpapi")),
      before,
    );
    for (const patch of [
      { target: "http://localhost:4000/api/publications" },
      { publicDatabase: "other" },
      { token: "short" },
      { uri: "private" },
    ])
      assert.throws(() => validatePublicationConfig({ ...value, ...patch }));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("normal targets cannot relax TEST guards or accept unsafe TLS/non-loopback destinations", () => {
  const client = { options: { srvHost: "synthetic.mongodb.net", tls: true } },
    db = { databaseName: "medical-center-dev" },
    environment = {
      mode: "normal-local",
      publicTarget: {
        database: "medical-center-dev",
        srvHost: "synthetic.mongodb.net",
      },
    };
  assert.doesNotThrow(() =>
    assertPublicationStorage(db, client, true, "public", environment),
  );
  assert.throws(() => assertPublicationStorage(db, client, true, "public"));
  for (const patch of [
    { tls: false },
    { tlsInsecure: true },
    { tlsAllowInvalidCertificates: true },
    { tlsAllowInvalidHostnames: true },
    { srvHost: "another.mongodb.net" },
  ])
    assert.throws(() =>
      assertPublicationStorage(
        db,
        { options: { ...client.options, ...patch } },
        true,
        "public",
        environment,
      ),
    );
  assert.equal(
    validateReceiverTarget(
      "http://127.0.0.1:4000/api/publications",
      true,
      environment,
    ),
    "http://127.0.0.1:4000/api/publications",
  );
  assert.throws(() =>
    validateReceiverTarget("http://127.0.0.1:4000/api/publications", true),
  );
  assert.throws(() =>
    validateReceiverTarget(
      "http://192.168.1.2:4000/api/publications",
      true,
      environment,
    ),
  );
});
test("operator rejects unknown, duplicate or implicit actions before any connection", () => {
  for (const args of [
    [],
    ["--action", "import", "--action", "backup"],
    ["--uri", "secret"],
    ["--action", "wipe"],
  ])
    assert.throws(() => parseTransitionArguments(args));
  assert.equal(
    parseTransitionArguments(["--action", "plan"])["--action"],
    "plan",
  );
});

test("complete operator actions cannot interleave resume with activation/rollback and release only their own lock", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cedar-publication-lock-"));
  let proceed, entered;
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  const wait = new Promise((resolve) => {
    proceed = resolve;
  });
  const state = { mode: "cedar", paused: true };
  try {
    const resume = withPublicationOperatorLock(directory, async () => {
      assert.equal(state.mode, "cedar");
      entered();
      await wait;
      state.paused = false;
    });
    await ready;
    await assert.rejects(
      withPublicationOperatorLock(directory, async () => {
        state.paused = true;
        state.mode = "legacy";
      }),
      /Another publication operator/,
    );
    proceed();
    await resume;
    await withPublicationOperatorLock(directory, async () => {
      state.paused = true;
      state.mode = "legacy";
    });
    assert.deepEqual(state, { mode: "legacy", paused: true });
    await assert.rejects(
      withPublicationOperatorLock(directory, () => {
        throw new Error("Synthetic failure");
      }),
      /Synthetic failure/,
    );
    await withPublicationOperatorLock(directory, async () => {});
  } finally {
    proceed?.();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a separate owned Node process cannot enter an active operator transition", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "cedar-publication-lock-process-"),
  );
  try {
    await withPublicationOperatorLock(directory, async () => {
      const source =
        "const {withPublicationOperatorLock}=await import(process.argv[1]);try{await withPublicationOperatorLock(process.argv[2],async()=>{});process.exitCode=2;}catch(error){if(!error.message.startsWith('Another publication operator'))throw error;console.log('blocked');}";
      const result = await promisify(execFile)(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          source,
          new URL("../src/publication-operator-lock.js", import.meta.url).href,
          directory,
        ],
        { windowsHide: true, timeout: 5000 },
      );
      assert.equal(result.stdout.trim(), "blocked");
      assert.equal(result.stderr, "");
    });
    await withPublicationOperatorLock(directory, async () => {});
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
