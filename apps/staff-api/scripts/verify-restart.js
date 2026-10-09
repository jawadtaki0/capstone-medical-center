import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { connectStaffDatabase } from "../src/db.js";
import { createVault } from "../src/local-security.js";
import {
  assertIsolatedTestTarget,
  STAFF_COLLECTIONS,
  syntheticProfile,
  syntheticPassword,
} from "../test/helpers/security-fixture.js";
import {
  stopOwnedMongo,
  startPrivateMongo,
  checkOwnedMongo,
  sleep,
} from "./mongo-process.js";
import { generate } from "otplib";

let connection;
let vault;
let api;
let restartedMongo;
let stage = "isolated test connection";
const code = randomBytes(20).toString("hex");
const username = `synthetic.${randomBytes(6).toString("hex")}`;
const password = syntheticPassword();
async function request(path, body, token) {
  const response = await fetch(`http://127.0.0.1:4101${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(5000),
  });
  return { status: response.status, body: await response.json() };
}
async function startApi() {
  api = spawn(
    process.execPath,
    [
      fileURLToPath(new URL("../src/server.js", import.meta.url)),
      "--demo-loopback",
      "--test-database",
    ],
    { windowsHide: true, stdio: "ignore" },
  );
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      if ((await request("/health")).status === 200) return;
    } catch {}
    if (api.exitCode !== null) throw new Error("Test authority exited.");
    await sleep(500);
  }
  throw new Error("Test authority did not become available.");
}
async function stopApi() {
  if (!api) return;
  const current = api;
  api = undefined;
  current.kill();
  if (current.exitCode === null)
    await new Promise((resolve) => current.once("exit", resolve));
}
try {
  connection = await connectStaffDatabase({
    database: "capstone_staff_test",
    demoMode: true,
  });
  assertIsolatedTestTarget(connection);
  vault = createVault(connection.config.key);
  for (const name of STAFF_COLLECTIONS)
    await connection.db.collection(name).deleteMany({});
  await connection.db
    .collection("installation_state")
    .insertOne({
      _id: "first-admin",
      status: "issued",
      codeHash: createHash("sha256").update(code).digest("hex"),
      expiresAt: new Date(Date.now() + 30 * 60000),
      attempts: 0,
    });
  await startApi();
  assert.equal(
    (
      await request("/setup/claim", {
        code,
        username,
        password,
        profile: syntheticProfile(),
      })
    ).status,
    200,
  );
  stage = "API and isolated database process restart";
  await stopApi();
  await connection.client.close();
  await stopOwnedMongo();
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      await checkOwnedMongo();
      await sleep(250);
    } catch {
      break;
    }
  }
  restartedMongo = await startPrivateMongo();
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      await checkOwnedMongo();
      break;
    } catch {
      if (attempt === 39) throw new Error("Private database restart failed.");
      await sleep(500);
    }
  }
  connection = await connectStaffDatabase({
    database: "capstone_staff_test",
    demoMode: true,
  });
  assertIsolatedTestTarget(connection);
  await startApi();
  const login = await request("/auth/login", { username, password });
  assert.equal(login.status, 200);
  assert.equal(login.body.kind, "enroll");
  assert.equal(
    await connection.db.collection("accounts").countDocuments({}),
    1,
  );
  assert.equal(
    (
      await request("/setup/claim", {
        code,
        username,
        password,
        profile: syntheticProfile(),
      })
    ).status,
    401,
  );
  const enrollment = await request("/mfa/enroll", {
    challenge: login.body.challenge,
  });
  assert.equal(enrollment.status, 200);
  const completed = await request("/mfa/complete", {
    challenge: login.body.challenge,
    code: await generate({ secret: enrollment.body.secret }),
  });
  assert.equal(completed.status, 200);
  assert.equal(
    (await request("/mfa/acknowledge", {}, completed.body.token)).status,
    200,
  );
  stage = "persistent authenticated session across API restart";
  await stopApi();
  await startApi();
  assert.equal(
    (await request("/workspace", undefined, completed.body.token)).status,
    200,
  );
  stage = "database outage with API still running";
  await connection.client.close();
  await stopOwnedMongo();
  let unavailable = false;
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      if ((await request("/health")).status === 503) {
        unavailable = true;
        break;
      }
    } catch {}
    await sleep(500);
  }
  assert.equal(unavailable, true);
  assert.equal(
    (await request("/workspace", undefined, completed.body.token)).status,
    503,
  );
  stage = "database recovery without API restart";
  restartedMongo = await startPrivateMongo();
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      if ((await request("/health")).status === 200) break;
    } catch {}
    if (attempt === 39)
      throw new Error("Authority did not recover its isolated database.");
    await sleep(500);
  }
  connection = await connectStaffDatabase({
    database: "capstone_staff_test",
    demoMode: true,
  });
  assertIsolatedTestTarget(connection);
  assert.equal(
    (await request("/workspace", undefined, completed.body.token)).status,
    200,
  );
  assert.equal(
    (await request("/auth/logout", {}, completed.body.token)).status,
    200,
  );
  await stopApi();
  await startApi();
  assert.equal(
    (await request("/workspace", undefined, completed.body.token)).status,
    401,
  );
  assert.equal((await request("/setup/status")).body.available, false);
  console.log(
    "PASS: actual staff API and owned MongoDB restarts preserve first Admin, enrollment recovery, completed bootstrap, sessions and logout revocation; database outage denies protected access and recovers without API restart. Existing service untouched.",
  );
} catch {
  console.error(
    `FAIL: process restart verification at '${stage}'. No secrets printed.`,
  );
  process.exitCode = 1;
} finally {
  await stopApi();
  if (connection) {
    assertIsolatedTestTarget(connection);
    for (const name of STAFF_COLLECTIONS)
      await connection.db
        .collection(name)
        .deleteMany({})
        .catch(() => {});
    await connection.client.close();
  }
  vault?.destroy();
  // Only this test-owned instance is stopped; restart staff:db before further tests.
  if (restartedMongo) {
    await stopOwnedMongo().catch(() => {});
  }
}
