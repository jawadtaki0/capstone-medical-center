// Allow the existing free service to wake, as the request catalogue already does.
export const PUBLIC_READ_TIMEOUT_MS = 75000;

export async function readPublicJson(
  url,
  { signal, request = fetch, timeoutMs = PUBLIC_READ_TIMEOUT_MS } = {},
) {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const cancel = () => controller.abort(signal.reason);
  signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(
    () =>
      controller.abort(
        new DOMException("Public data timed out.", "TimeoutError"),
      ),
    timeoutMs,
  );
  let rejectOnAbort;
  const aborted = new Promise((_, reject) => {
    rejectOnAbort = () => reject(controller.signal.reason);
    controller.signal.addEventListener("abort", rejectOnAbort, { once: true });
  });
  try {
    // Bound headers AND body parsing, even when a transport fails to honour abort.
    return await Promise.race([
      (async () => {
        const response = await request(url, { signal: controller.signal });
        if (!response.ok) throw Error("Public data request failed.");
        return await response.json();
      })(),
      aborted,
    ]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
    controller.signal.removeEventListener("abort", rejectOnAbort);
  }
}
