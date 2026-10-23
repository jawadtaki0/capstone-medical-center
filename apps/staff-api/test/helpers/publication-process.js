import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

// Owned TEST children only. Credentials travel over private parent/child IPC,
// never command arguments, renderer IPC, files, logs or the normal runtime.
export async function startPublicationProcess(options) {
  const child = fork(
    fileURLToPath(new URL("./publication-process-child.js", import.meta.url)),
    ["--isolated-publication-review"],
    {
      execArgv: [],
      windowsHide: true,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    },
  );
  let exited = false,
    serial = 0,
    claimed = false,
    stopPromise;
  const requests = new Map();
  const exit = new Promise((resolve) =>
    child.once("exit", () => {
      exited = true;
      for (const job of requests.values()) {
        clearTimeout(job.timer);
        job.reject(new Error("Owned publication process exited."));
      }
      requests.clear();
      resolve();
    }),
  );
  child.on("message", (message) => {
    if (message?.type === "claimed") claimed = true;
    if (message?.type !== "result") return;
    const job = requests.get(message.id);
    if (!job) return;
    clearTimeout(job.timer);
    requests.delete(message.id);
    if (message.ok) job.resolve(message.result);
    else job.reject(new Error("Owned publication control failed."));
  });
  async function boundedExit(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), ms);
      exit.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }
  async function stop() {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      if (exited) return;
      if (child.connected) child.send({ type: "stop" }, () => {});
      if (!(await boundedExit(6000))) {
        child.kill();
        if (!(await boundedExit(5000)))
          throw new Error("Owned publication process did not stop.");
      }
    })();
    return stopPromise;
  }
  try {
    const ready = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Owned publication process startup timed out.")),
        20000,
      );
      const fail = () => {
        clearTimeout(timer);
        reject(new Error("Owned publication process startup failed."));
      };
      child.once("error", fail);
      child.once("exit", fail);
      child.on("message", (message) => {
        if (message?.type === "failed") {
          clearTimeout(timer);
          reject(
            new Error(
              `Owned publication startup failed at ${["validation", "TEST connection", "TEST port validation", "receiver initialization", "sender initialization", "owned listener"].includes(message.stage) ? message.stage : "unknown stage"}.`,
            ),
          );
          return;
        }
        if (message?.type !== "ready") return;
        clearTimeout(timer);
        child.removeListener("error", fail);
        child.removeListener("exit", fail);
        resolve(message);
      });
      child.send({ type: "boot", options });
    });
    return {
      port: ready.port,
      origin: ready.port ? `http://127.0.0.1:${ready.port}` : null,
      stop,
      async crash() {
        if (!exited) {
          child.kill();
          if (!(await boundedExit(5000)))
            throw new Error("Owned crash simulation did not finish.");
        }
      },
      async waitForClaim() {
        const deadline = Date.now() + 10000;
        while (!claimed && !exited && Date.now() < deadline) await delay(25);
        if (!claimed)
          throw new Error("Owned sender did not claim the TEST job.");
      },
      control(action) {
        if (!["tick", "pause", "resume"].includes(action) || exited)
          return Promise.reject(new Error("Invalid owned process control."));
        const id = ++serial;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            requests.delete(id);
            reject(new Error("Owned control timed out."));
          }, 15000);
          requests.set(id, { resolve, reject, timer });
          child.send({ type: "control", id, action }, (error) => {
            if (error) {
              clearTimeout(timer);
              requests.delete(id);
              reject(new Error("Owned process unavailable."));
            }
          });
        });
      },
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
