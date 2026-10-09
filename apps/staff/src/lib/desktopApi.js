// Reconstruct errors on the renderer side, after Electron has copied the plain
// IPC envelope. No session/challenge tokens are added to these public results.
export function createDesktopApi(bridge) {
  if (!bridge || typeof bridge !== "object") return undefined;
  const unavailable = () =>
    Object.assign(
      new Error(
        "The local staff application connection is unavailable. Please try again.",
      ),
      { code: "AUTHORITY_UNAVAILABLE" },
    );
  return Object.freeze(
    Object.fromEntries(
      Object.entries(bridge)
        .filter(([, action]) => typeof action === "function")
        .map(([name, action]) => [
          name,
          async (payload) => {
            let reply;
            try {
              reply = await action(payload);
            } catch {
              throw unavailable();
            }
            if (!reply || typeof reply.ok !== "boolean") throw unavailable();
            if (!reply.ok) {
              const code =
                typeof reply.error?.code === "string" &&
                /^[A-Za-z0-9_]{1,64}$/.test(reply.error.code)
                  ? reply.error.code
                  : "INVALID_ACTION";
              const message =
                typeof reply.error?.message === "string"
                  ? reply.error.message
                  : "This application action was refused.";
              throw Object.assign(new Error(message), { code });
            }
            return reply.result;
          },
        ]),
    ),
  );
}

// Capture one stable adapter instead of rebuilding it during React renders.
export const desktopApi = createDesktopApi(globalThis.window?.staffApi);
