import { mkdir, writeFile, readdir, access } from "node:fs/promises";
import { join } from "node:path";
import { createConnection } from "node:net";
import { MongoClient } from "mongodb";
import {
  initializeAuthority,
  protectDirectory,
  runtimeDirectory,
} from "../src/local-security.js";
import { startPrivateMongo, rootClient, sleep } from "./mongo-process.js";

function portBusy() {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port: 27018 });
    socket.setTimeout(1000);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
  });
}
async function prepare() {
  if (!process.argv.includes("--demo-loopback"))
    throw new Error("Explicit --demo-loopback is required.");
  const readyPath = join(runtimeDirectory, "ready.json");
  try {
    await access(readyPath);
    console.log("Private staff runtime already prepared; no changes made.");
    return;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (await portBusy())
    throw new Error("Port 27018 is occupied; refusing to touch its server.");
  await protectDirectory();
  const dataPath = join(runtimeDirectory, "mongo-data");
  await mkdir(dataPath, { recursive: true });
  const files = await readdir(dataPath);
  let authority;
  try {
    await access(join(runtimeDirectory, "authority.dpapi"));
    authority = await initializeAuthority();
  } catch (error) {
    if (files.length)
      throw new Error(
        "Data exists without a recoverable key; refusing automatic reinitialization.",
      );
    authority = await initializeAuthority();
  }
  try {
    await writeFile(
      join(runtimeDirectory, "replica.key"),
      authority.replicaKey,
      { flag: "wx" },
    );
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const processHandle = await startPrivateMongo();
  const initial = new MongoClient(
    "mongodb://127.0.0.1:27018/?directConnection=true",
    { serverSelectionTimeoutMS: 1000 },
  );
  let root;
  try {
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        await initial.connect();
        await initial.db("admin").command({ hello: 1 });
        break;
      } catch {
        if (attempt === 39) throw new Error("Private MongoDB did not start.");
        await sleep(500);
      }
    }
    let hello = await initial.db("admin").command({ hello: 1 });
    if (!hello.setName) {
      await initial
        .db("admin")
        .command({
          replSetInitiate: {
            _id: "capstoneStaffDev",
            members: [{ _id: 0, host: "127.0.0.1:27018" }],
          },
        });
    } else if (hello.setName !== "capstoneStaffDev")
      throw new Error("Unexpected replica-set identity.");
    for (let attempt = 0; attempt < 40; attempt++) {
      hello = await initial.db("admin").command({ hello: 1 });
      if (hello.isWritablePrimary) break;
      if (attempt === 39)
        throw new Error("Private replica set did not become primary.");
      await sleep(500);
    }
    try {
      await initial
        .db("admin")
        .command({
          createUser: "staff_root",
          pwd: authority.rootPassword,
          roles: [{ role: "root", db: "admin" }],
        });
    } catch (error) {
      if (![13, 51003].includes(error.code)) throw error;
    }
    root = rootClient(authority);
    await root.connect();
    for (const [database, username, password] of [
      ["capstone_staff_dev", "staff_app", authority.appPassword],
      ["capstone_staff_test", "staff_test", authority.testPassword],
    ]) {
      const users = await root.db(database).command({ usersInfo: username });
      if (!users.users.length)
        await root
          .db(database)
          .command({
            createUser: username,
            pwd: password,
            roles: [{ role: "readWrite", db: database }],
          });
      await root
        .db(database)
        .collection("installation_state")
        .updateOne(
          { _id: "local-runtime" },
          {
            $setOnInsert: {
              runtimeId: authority.runtimeId,
              syntheticOnly: true,
            },
          },
          { upsert: true },
        );
    }
    await writeFile(
      readyPath,
      JSON.stringify({
        version: 1,
        syntheticOnly: true,
        port: 27018,
        replicaSet: "capstoneStaffDev",
      }),
      { flag: "wx" },
    );
    console.log(
      "Isolated staff databases prepared with authentication and transaction-capable topology. Existing service untouched.",
    );
  } finally {
    await initial.close();
    if (root) {
      try {
        await root.db("admin").command({ shutdown: 1 });
      } catch {}
      await root.close();
    }
    if (processHandle.exitCode === null) processHandle.kill();
  }
}
prepare().catch(() => {
  console.error(
    "Private staff setup failed. No public database or existing service was modified. Inspect the private runtime before retrying.",
  );
  process.exitCode = 1;
});
