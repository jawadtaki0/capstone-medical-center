import { fork, spawn } from "node:child_process";
import { MongoClient } from "mongodb";
import { readAuthority } from "../../src/local-security.js";
import { loadConfig } from "../../src/config.js";
import { mongoBinary, rootClient } from "../mongo-process.js";
import {
  checkLauncherFiles,
  childEnvironment,
  hostEntry,
  projectRoot,
  serverEntry,
} from "./configuration.js";
import {
  acquireLauncherLock,
  expectedListener,
  inspectListener,
  safeProcessOptions,
  applicationProcessOptions,
} from "./windows.js";
import { launchStaff, LauncherError } from "./orchestrator.js";

export async function startOwnedHost(kind, config) {
  const child = fork(hostEntry, [kind, "--demo-loopback"], {
    ...safeProcessOptions(config.runtimeDirectory),
    execPath: config.nodePath,
    execArgv: [],
    detached: true,
    cwd: projectRoot,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  return controlOwnedHost(child);
}

export function controlOwnedHost(child, timeoutMs = 12000) {
  let exited = false;
  const closed = new Promise((resolve) => {
    child.once("exit", (code) => {
      exited = true;
      resolve(code);
    });
    child.once("error", () => {
      exited = true;
      resolve(1);
    });
  });
  const request = (type, response) =>
    new Promise((resolve, reject) => {
      if (exited || !child.connected)
        return reject(new Error("Owned host unavailable."));
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Owned host timeout."));
      }, timeoutMs);
      const onMessage = (message) => {
        if (message?.type === response) {
          cleanup();
          resolve();
        }
      };
      function cleanup() {
        clearTimeout(timer);
        child.off("message", onMessage);
      }
      child.on("message", onMessage);
      child.send({ type }, (error) => {
        if (error) {
          cleanup();
          reject(new Error("Owned host unavailable."));
        }
      });
    });
  let stopping;
  return {
    child,
    async prepareRelease() {
      await request("prepare-release", "release-ready");
    },
    async commitRelease() {
      await request("release", "released");
    },
    detach() {
      if (child.connected) child.disconnect();
      child.unref();
    },
    stop() {
      if (stopping) return stopping;
      stopping = (async () => {
        if (exited) return;
        if (!child.connected) throw new Error("Ownership channel unavailable.");
        child.send({ type: "stop" }, () => {});
        let timer;
        try {
          const code = await Promise.race([
            closed,
            new Promise((_, reject) => {
              timer = setTimeout(
                () => reject(new Error("Owned service shutdown timed out.")),
                timeoutMs,
              );
            }),
          ]);
          if (code !== 0) throw new Error("Owned service shutdown failed.");
        } finally {
          clearTimeout(timer);
        }
      })();
      return stopping;
    },
  };
}

async function healthyApi() {
  try {
    const response = await fetch("http://127.0.0.1:4100/health", {
      redirect: "error",
      signal: AbortSignal.timeout(3000),
    });
    const value = await response.json();
    return (
      response.ok &&
      value.service === "medical-center-staff-api" &&
      value.status === "ok" &&
      value.database === "connected" &&
      Number.isFinite(Date.parse(value.serverNow))
    );
  } catch {
    return false;
  }
}

export async function runConfiguredLauncher(config, options = {}) {
  if (
    process.platform !== "win32" ||
    process.env.CAPSTONE_STAFF_RUNTIME_DIR !== config.runtimeDirectory
  )
    throw new LauncherError(
      "Run the launcher with its configured Windows runtime. No alternate database or HTTP target is allowed.",
    );
  let authority;
  let dbConfig;
  const database = {
    name: "database",
    async probe() {
      const rows = await inspectListener(27018);
      const recognized = expectedListener(rows, {
        executable: mongoBinary,
        entry: ["--dbpath"],
        arguments: [
          "--auth",
          "--replSet",
          "capstoneStaffDev",
          `${config.runtimeDirectory}\\mongo-data`,
        ],
      });
      if (recognized === "absent" || recognized === "unexpected")
        return recognized;
      const root = rootClient(authority, { socketTimeoutMS: 3000 });
      const app = new MongoClient(dbConfig.uri, {
        serverSelectionTimeoutMS: 3000,
        connectTimeoutMS: 3000,
        socketTimeoutMS: 3000,
      });
      try {
        await root.connect();
        const hello = await root.db("admin").command({ hello: 1 });
        const marker = await root
          .db(dbConfig.database)
          .collection("installation_state")
          .findOne({ _id: "local-runtime" }, { projection: { runtimeId: 1 } });
        if (
          hello.setName !== dbConfig.replicaSet ||
          marker?.runtimeId !== authority.runtimeId
        )
          return "unexpected";
        if (!hello.isWritablePrimary || hello.hosts?.length !== 1)
          return "waiting";
        await app.connect();
        await app.db(dbConfig.database).command({ ping: 1 });
        return "ready";
      } catch {
        return "waiting";
      } finally {
        await Promise.all([root.close(), app.close()]);
      }
    },
    async start() {
      return startOwnedHost("mongo", config);
    },
  };
  const server = {
    name: "staff server",
    async probe() {
      const rows = await inspectListener(4100);
      const recognized = expectedListener(rows, {
        executable: config.nodePath,
        entry: [serverEntry, "apps/staff-api/src/server.js", hostEntry],
        arguments: ["--demo-loopback"],
      });
      if (recognized === "absent" || recognized === "unexpected")
        return recognized;
      return (await healthyApi()) ? "ready" : "waiting";
    },
    async start() {
      return startOwnedHost("api", config);
    },
  };
  await launchStaff({
    ...options,
    services: [database, server],
    async preflight() {
      await checkLauncherFiles(config);
      try {
        authority = await readAuthority();
        dbConfig = await loadConfig({ demoMode: true });
      } catch {
        throw new LauncherError(
          "The protected existing staff runtime could not be opened. Check its configured path and signed-in Windows user; no keys or accounts were recreated.",
        );
      }
    },
    lock: () =>
      acquireLauncherLock(`${projectRoot}|${config.runtimeDirectory}`),
    openApp: () =>
      new Promise((resolve, reject) => {
        const child = spawn(config.appPath, ["--demo-loopback"], {
          ...applicationProcessOptions(config.runtimeDirectory),
          cwd: projectRoot,
        });
        child.once("error", () =>
          reject(
            new LauncherError(
              "The selected packaged Cedar Staff application could not start. Check that the full package exists.",
            ),
          ),
        );
        child.once("spawn", () => {
          child.unref();
          resolve();
        });
      }),
  });
  // Avoid keeping decrypted authority references after orchestration. This is
  // reference minimization, not a claim of secure process-memory erasure.
  authority = undefined;
  dbConfig = undefined;
}
