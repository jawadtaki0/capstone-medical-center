import { useEffect, useRef, useState } from "react";
import OperationalRegistry from "./OperationalRegistry.jsx";
import LoadingStatus from "../../../../shared/ui/LoadingStatus.jsx";

export default function StaffScopeAssignments({
  api,
  onSensitiveAction,
  onError,
}) {
  const [state, setState] = useState(null),
    [error, setError] = useState("");
  const generation = useRef(0);
  async function load() {
    const current = ++generation.current;
    try {
      const value = await api.operationalState();
      if (current === generation.current) {
        setState(value);
        setError("");
      }
    } catch (failure) {
      if (current === generation.current) {
        setError(failure.message);
        onError?.(failure);
      }
    }
  }
  useEffect(() => {
    void load();
    return () => {
      generation.current++;
    };
  }, [api]);
  async function assign(payload) {
    const current = generation.current;
    try {
      await onSensitiveAction(() => {
        if (current !== generation.current)
          throw Error("Reopen staff access before saving.");
        return api.assignOperationalScopes(payload);
      });
      if (current === generation.current) await load();
    } catch (failure) {
      onError?.(failure);
      throw failure;
    }
  }
  return (
    <details className="staff-workspace-card">
      <summary>Staff clinic/service access</summary>
      {error && (
        <p className="staff-error" role="alert">
          {error}
          <button type="button" className="staff-button" onClick={load}>
            Retry staff access
          </button>
        </p>
      )}
      {!state && !error && <LoadingStatus label="Loading staff access…" />}
      {state?.isAdmin && (
        <OperationalRegistry
          mode="access"
          state={state}
          api={api}
          onAssign={assign}
          onError={onError}
        />
      )}
    </details>
  );
}
