import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { MongoClient } from "mongodb";
import { runtimeDirectory, readAuthority } from "../src/local-security.js";

export const mongoBinary = join(
  process.env.ProgramFiles || "C:\\Program Files",
  "MongoDB",
  "Server",
  "8.2",
  "bin",
  "mongod.exe",
);
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function startPrivateMongo(options = {}) {
  await access(mongoBinary);
  const child = spawn(
    mongoBinary,
    [
      "--dbpath",
      join(runtimeDirectory, "mongo-data"),
      "--bind_ip",
      "127.0.0.1",
      "--port",
      "27018",
      "--replSet",
      "capstoneStaffDev",
      "--auth",
      "--keyFile",
      join(runtimeDirectory, "replica.key"),
      "--logpath",
      join(runtimeDirectory, "mongo.log"),
      "--logappend",
    ],
    { ...options, windowsHide: true, stdio: "ignore", shell: false },
  );
  child.on("error", () => {});
  return child;
}
export function rootClient(authority, options = {}) {
  return new MongoClient(
    `mongodb://staff_root:${encodeURIComponent(authority.rootPassword)}@127.0.0.1:27018/admin?replicaSet=capstoneStaffDev&directConnection=true`,
    { serverSelectionTimeoutMS: 3000, connectTimeoutMS: 3000, ...options },
  );
}
export async function checkOwnedMongo() {
  const authority = await readAuthority();
  const client = rootClient(authority);
  try {
    await client.connect();
    const hello = await client.db("admin").command({ hello: 1 });
    const marker = await client
      .db("capstone_staff_dev")
      .collection("installation_state")
      .findOne({ _id: "local-runtime" });
    if (
      hello.setName !== "capstoneStaffDev" ||
      marker?.runtimeId !== authority.runtimeId
    )
      throw new Error("Local MongoDB ownership mismatch.");
    return true;
  } finally {
    await client.close();
  }
}
export async function stopOwnedMongo() {
  await checkOwnedMongo();
  const client = rootClient(await readAuthority());
  try {
    await client.connect();
    await client.db("admin").command({ shutdown: 1 });
  } catch (error) {
    if (
      !["MongoNetworkError", "MongoServerSelectionError"].includes(error.name)
    )
      throw error;
  } finally {
    await client.close();
  }
}
