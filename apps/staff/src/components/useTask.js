import { useEffect, useRef, useState } from "react";
import { isAccessError } from "../lib/staffManagement.js";

// One request at a time per card, with the server's own error message.
export function useTask(onError) {
  const live = useRef(true),
    pending = useRef(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  async function run(action, onFailure) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const value = await action();
      if (live.current) return value;
    } catch (e) {
      if (!live.current) return;
      setError(e.message);
      onFailure?.(e);
      if (isAccessError(e)) onError?.(e);
    } finally {
      pending.current = false;
      if (live.current) setBusy(false);
    }
  }
  return { busy, error, run };
}
