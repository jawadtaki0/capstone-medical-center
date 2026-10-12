import { useEffect, useId, useRef, useState } from "react";
import { observeChallenge, sessionTiming } from "../lib/activity.js";
import { isAccessError } from "../lib/staffManagement.js";

export default function PasswordChange({
  api,
  onSaved,
  onError,
  onClose,
  onPendingChange,
  returnFocus,
}) {
  const id = useId(),
    dialog = useRef(null),
    heading = useRef(null);
  const live = useRef(true),
    generation = useRef(0),
    pending = useRef(false),
    deadline = useRef(null),
    cancelPending = useRef(false);
  const callbacks = useRef({ onSaved, onError, onClose, onPendingChange });
  callbacks.current = { onSaved, onError, onClose, onPendingChange };
  const [phase, setPhase] = useState("password"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [password, setPassword] = useState(""),
    [code, setCode] = useState(""),
    [method, setMethod] = useState("totp");
  const [newPassword, setNewPassword] = useState(""),
    [confirmation, setConfirmation] = useState("");
  function clearInputs() {
    setPassword("");
    setCode("");
    setNewPassword("");
    setConfirmation("");
  }
  function current(expected = generation.current) {
    if (!live.current || expected !== generation.current) return false;
    if (
      deadline.current &&
      sessionTiming(deadline.current, Date.now()).expired
    ) {
      generation.current += 1;
      deadline.current = null;
      clearInputs();
      setPhase("expired");
      setBusy(false);
      setError(
        "Password-change authorization expired. Private entries were cleared. If you already submitted a save, sign in again to check its outcome.",
      );
      callbacks.current.onPendingChange?.(false);
      void api.cancelPasswordChange().catch((failure) => {
        if (live.current && isAccessError(failure))
          callbacks.current.onError?.(failure);
      });
      return false;
    }
    return true;
  }
  const check = useRef(current);
  check.current = current;
  useEffect(() => {
    live.current = true;
    const element = dialog.current;
    element.showModal();
    heading.current?.focus({ preventScroll: true });
    const tick = () => check.current();
    const timer = setInterval(tick, 1000);
    const events = ["pointerdown", "keydown", "input"];
    events.forEach((name) => element.addEventListener(name, tick, true));
    window.addEventListener("focus", tick);
    window.addEventListener("pageshow", tick);
    document.addEventListener("visibilitychange", tick);
    return () => {
      live.current = false;
      generation.current += 1;
      deadline.current = null;
      clearInterval(timer);
      events.forEach((name) => element.removeEventListener(name, tick, true));
      window.removeEventListener("focus", tick);
      window.removeEventListener("pageshow", tick);
      document.removeEventListener("visibilitychange", tick);
      element.close();
      returnFocus.current?.focus({ preventScroll: true });
      callbacks.current.onPendingChange?.(false);
    };
  }, [returnFocus]);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, [phase]);
  function accept(result, startedAt) {
    const observed = observeChallenge(result, startedAt);
    deadline.current = observed;
    if (!current()) return;
    setPhase(result.kind === "password_mfa" ? "mfa" : "new");
  }
  async function act(action) {
    if (pending.current || cancelPending.current || !current()) return;
    const expected = generation.current,
      startedAt = Date.now();
    pending.current = true;
    setBusy(true);
    setError("");
    callbacks.current.onPendingChange?.(true);
    try {
      const result = await action();
      if (!current(expected)) return;
      if (result.passwordChanged) {
        clearInputs();
        deadline.current = null;
        generation.current += 1;
        callbacks.current.onSaved?.();
      } else {
        clearInputs();
        accept(result, startedAt);
      }
    } catch (failure) {
      if (!current(expected)) return;
      setError(failure.message || "Password change could not be completed.");
      // Busy is not a failed authentication or an admitted history job. Keep
      // entered values and the current authorization so the user can retry.
      if (failure.code !== "password_change_busy") {
        setPassword("");
        setCode("");
        if (failure.code === "password_change_expired") {
          clearInputs();
          deadline.current = null;
          setPhase("expired");
        } else if (isAccessError(failure)) {
          clearInputs();
          callbacks.current.onError?.(failure);
        }
      }
    } finally {
      pending.current = false;
      if (live.current && expected === generation.current) {
        setBusy(false);
        callbacks.current.onPendingChange?.(false);
      }
    }
  }
  async function cancel() {
    if (cancelPending.current || !live.current) return;
    cancelPending.current = true;
    generation.current += 1;
    clearInputs();
    deadline.current = null;
    setPhase("cancelling");
    setBusy(true);
    setError("");
    callbacks.current.onPendingChange?.(true);
    try {
      await api.cancelPasswordChange();
      if (live.current) callbacks.current.onClose?.();
    } catch (failure) {
      if (live.current) {
        setError(
          `Cancellation could not be confirmed. Retry Cancel. ${failure.message}`,
        );
        if (isAccessError(failure)) callbacks.current.onError?.(failure);
      }
    } finally {
      cancelPending.current = false;
      if (live.current) {
        setBusy(false);
        callbacks.current.onPendingChange?.(false);
      }
    }
  }
  return (
    <dialog
      ref={dialog}
      className="staff-verification-dialog staff-email-dialog"
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-description`}
      onCancel={(event) => {
        event.preventDefault();
        void cancel();
      }}
    >
      <h2 ref={heading} id={`${id}-title`} tabIndex={-1}>
        Change password
      </h2>
      <p id={`${id}-description`} className="staff-help">
        Change only your own password. On success, all your sessions end and you
        must sign in again. Profile, verified contacts and authenticator
        enrollment stay unchanged. Recovery is not included.
      </p>
      <p role="status" className="staff-eyebrow">
        {phase === "password"
          ? "1 · Confirm current password"
          : phase === "mfa"
            ? "2 · Fresh administrative MFA"
            : phase === "new"
              ? "Choose a never-used password"
              : phase === "expired"
                ? "Authorization expired"
                : "Cancelling securely"}
      </p>
      {error && (
        <p className="staff-error" role="alert">
          {error}
        </p>
      )}
      <form
        className="staff-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (phase === "password")
            void act(() => api.startPasswordChange({ password }));
          else if (phase === "mfa")
            void act(() => api.completePasswordIdentity({ method, code }));
          else if (phase === "new") {
            if (newPassword !== confirmation) {
              setError("New password and confirmation must match exactly.");
              return;
            }
            if (
              Array.from(newPassword).length < 15 ||
              Array.from(newPassword).length > 128
            ) {
              setError(
                "Choose a passphrase of 15–128 characters. Spaces are allowed.",
              );
              return;
            }
            void act(() =>
              api.savePasswordChange({ newPassword, confirmation }),
            );
          }
        }}
      >
        {phase === "password" && (
          <div className="staff-field">
            <label htmlFor={`${id}-current`}>
              Current password or passphrase
            </label>
            <input
              id={`${id}-current`}
              name="currentPassword"
              type="password"
              value={password}
              onChange={(event) => {
                if (current()) setPassword(event.target.value);
              }}
              required
              disabled={busy}
              autoComplete="off"
            />
          </div>
        )}
        {phase === "mfa" && (
          <>
            <p className="staff-help">
              Use a fresh authenticator code not already used to sign in, or an
              unused backup code. A backup code is consumed normally.
            </p>
            <div className="staff-field">
              <label htmlFor={`${id}-method`}>Identity factor</label>
              <select
                id={`${id}-method`}
                value={method}
                disabled={busy}
                onChange={(event) => {
                  if (!current()) return;
                  setMethod(event.target.value);
                  setCode("");
                }}
              >
                <option value="totp">Authenticator</option>
                <option value="backup">Unused backup code</option>
              </select>
            </div>
            <div className="staff-field">
              <label htmlFor={`${id}-factor`}>Identity verification code</label>
              <input
                id={`${id}-factor`}
                name="factor"
                type="password"
                value={code}
                onChange={(event) => {
                  if (current()) setCode(event.target.value);
                }}
                required
                disabled={busy}
                autoComplete="off"
              />
            </div>
          </>
        )}
        {phase === "new" && (
          <>
            <p className="staff-help">
              Use 15–128 characters, including spaces. Current and every
              recorded past password are rejected. Passwords never recorded
              before this feature cannot be reconstructed. Complete-history
              checks may take longer as history grows.
            </p>
            <div className="staff-field">
              <label htmlFor={`${id}-new`}>New password or passphrase</label>
              <input
                id={`${id}-new`}
                name="newPassword"
                type="password"
                value={newPassword}
                onChange={(event) => {
                  if (current()) setNewPassword(event.target.value);
                }}
                required
                disabled={busy}
                autoComplete="off"
              />
            </div>
            <div className="staff-field">
              <label htmlFor={`${id}-confirmation`}>Confirm new password</label>
              <input
                id={`${id}-confirmation`}
                name="confirmation"
                type="password"
                value={confirmation}
                onChange={(event) => {
                  if (current()) setConfirmation(event.target.value);
                }}
                required
                disabled={busy}
                autoComplete="off"
              />
            </div>
          </>
        )}
        {["password", "mfa", "new"].includes(phase) && (
          <button
            className="staff-button staff-button-primary"
            type="submit"
            disabled={busy}
          >
            {busy
              ? "Checking securely…"
              : phase === "password"
                ? "Confirm current password"
                : phase === "mfa"
                  ? "Verify identity"
                  : "Save password and sign out"}
          </button>
        )}
        {phase === "expired" && (
          <button
            className="staff-button"
            type="button"
            disabled={busy || pending.current}
            onClick={() => {
              generation.current += 1;
              setPhase("password");
              setError("");
            }}
          >
            Start password check again
          </button>
        )}
      </form>
      <button
        className="staff-button"
        type="button"
        disabled={cancelPending.current}
        onClick={() => void cancel()}
      >
        Cancel
      </button>
    </dialog>
  );
}
