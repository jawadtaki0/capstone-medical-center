export class LauncherError extends Error {
  constructor(message) {
    super(message);
    this.name = "LauncherError";
  }
}

// Only pass the live ChildProcess captured by this attempt's spawn. Never
// reconstruct this capability from a PID registry or port inspection result.
export function terminateCapturedChild(child) {
  if (child && child.exitCode === null && child.signalCode === null)
    child.kill();
}

// No PID registry: ownership is a live capability returned by start(), never
// inferred from a port or a persisted process identifier.
export async function launchStaff({
  services,
  preflight,
  lock,
  openApp,
  progress = () => {},
  signal,
  timeoutMs = 45000,
  clock = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const owned = [];
  let unlock;
  let completed = false;
  const cancelled = () => {
    if (signal?.aborted)
      throw new LauncherError(
        "Startup cancelled. Only services started by this attempt were cleaned up.",
      );
  };
  try {
    cancelled();
    await preflight();
    cancelled();
    unlock = await lock();
    for (const service of services) {
      progress(
        service.name === "database"
          ? "Checking database"
          : "Checking staff server",
      );
      const deadline = clock() + timeoutMs;
      let started = false;
      while (true) {
        cancelled();
        const state = await service.probe();
        cancelled();
        if (state === "unexpected")
          throw new LauncherError(
            `An unexpected service occupies the ${service.name} port. Nothing at that port was stopped. Ask the operator to check it.`,
          );
        if (clock() >= deadline)
          throw new LauncherError(
            `The ${service.name} did not become ready within the startup limit. Check its local configuration and retry.`,
          );
        if (state === "ready") break;
        if (state === "absent" && !started) {
          let child;
          try {
            child = await service.start();
          } catch {
            throw new LauncherError(
              `The ${service.name} could not start. Check its required executable and local runtime.`,
            );
          }
          owned.push(child);
          started = true;
        }
        await sleep(250);
      }
    }
    cancelled();
    try {
      await Promise.all(owned.map((child) => child.prepareRelease()));
    } catch {
      throw new LauncherError(
        "Service handoff failed. Startup was not completed.",
      );
    }
    cancelled();
    // The final open-and-detach is a short commit phase. Cancellation is
    // accepted before it, not after the selected application has opened.
    progress("Opening Cedar Staff");
    await openApp();
    // Handoff commits only after every owned host has acknowledged it. Until
    // then, even an acknowledged host still accepts this attempt's stop RPC.
    try {
      await Promise.all(owned.map((child) => child.commitRelease()));
    } catch {
      throw new LauncherError(
        "Service handoff could not commit. Startup was not completed.",
      );
    }
    for (const child of owned) child.detach();
    completed = true;
  } finally {
    let cleanupFailed = false;
    if (!completed)
      for (const child of owned.reverse()) {
        try {
          await child.stop();
        } catch {
          cleanupFailed = true;
        }
      }
    await unlock?.();
    if (cleanupFailed)
      throw new LauncherError(
        "Startup did not complete and an owned service could not finish its bounded shutdown. No reused or unrelated process was stopped. Ask the operator to check the local services before retrying.",
      );
  }
}
