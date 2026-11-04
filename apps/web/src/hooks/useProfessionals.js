import { useEffect, useState } from "react";
import { parseDirectoryResponse } from "../lib/directory.js";
import { readPublicJson } from "../lib/readPublicJson.js";

export async function loadProfessionals(signal, request = fetch) {
  return parseDirectoryResponse(
    await readPublicJson("/api/professionals", { signal, request }),
  );
}

export default function useProfessionals() {
  const [retryCount, setRetryCount] = useState(0);
  const [result, setResult] = useState({
    status: "loading",
    professionals: [],
  });
  useEffect(() => {
    const controller = new AbortController();
    setResult({ status: "loading", professionals: [] });
    // Defer one microtask so StrictMode's discarded effect never sends a request.
    Promise.resolve()
      .then(() => {
        if (controller.signal.aborted) return null;
        return loadProfessionals(controller.signal);
      })
      .then((professionals) => {
        if (!controller.signal.aborted)
          setResult({ status: "success", professionals });
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setResult({ status: "error", professionals: [] });
      });
    return () => controller.abort();
  }, [retryCount]);
  return { result, retry: () => setRetryCount((count) => count + 1) };
}
