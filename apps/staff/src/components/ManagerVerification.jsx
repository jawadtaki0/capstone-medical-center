import { useEffect, useId, useRef, useState } from "react";
import {
  isAccessError,
  managementErrorMessage,
} from "../lib/staffManagement.js";

export default function ManagerVerification({
  api,
  onComplete,
  onCancel,
  onError,
}) {
  const id = useId();
  const dialog = useRef(null);
  const previousFocus = useRef(null);
  const [step, setStep] = useState("password");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [method, setMethod] = useState("totp");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const alive = useRef(true);
  const cancelRef = useRef(onCancel);
  const busyRef = useRef(busy);
  cancelRef.current = onCancel;
  busyRef.current = busy;
  useEffect(() => {
    alive.current = true;
    previousFocus.current = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    function keyDown(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        if (!busyRef.current) cancelRef.current();
      }
      if (event.key !== "Tab") return;
      const controls = [
        ...dialog.current.querySelectorAll(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]',
        ),
      ];
      if (!controls.length) {
        event.preventDefault();
        dialog.current.focus();
        return;
      }
      const first = controls[0],
        last = controls.at(-1);
      if (
        event.shiftKey &&
        (document.activeElement === first ||
          !dialog.current.contains(document.activeElement))
      ) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last ||
          !dialog.current.contains(document.activeElement))
      ) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", keyDown);
    return () => {
      alive.current = false;
      document.removeEventListener("keydown", keyDown);
      document.body.style.overflow = previousOverflow;
      const opener = previousFocus.current;
      const usableOpener =
        opener?.isConnected && opener !== document.body && !opener.disabled;
      const target = usableOpener
        ? opener
        : document.querySelector(".staff-management-page h1, #staff-main h1");
      target?.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => {
    dialog.current?.querySelector("input")?.focus({ preventScroll: true });
  }, [step, method]);
  async function submit(event) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      if (step === "password") {
        const value = password;
        setPassword("");
        await api.startVerification({ password: value });
        if (alive.current) setStep("factor");
      } else {
        const value = code.trim();
        setCode("");
        const result = await api.completeVerification({ code: value, method });
        if (alive.current) await onComplete(result);
      }
    } catch (failure) {
      if (alive.current) {
        setError(managementErrorMessage(failure));
        if (isAccessError(failure)) onError?.(failure);
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return (
    <div className="staff-modal-backdrop">
      <section
        ref={dialog}
        className="staff-verification-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-description`}
        tabIndex={-1}
      >
        <p className="staff-eyebrow">CONFIRM YOUR OWN IDENTITY</p>
        <h2 id={`${id}-title`}>Verify this management action</h2>
        <p id={`${id}-description`} className="staff-intro">
          Sensitive changes require your password and an authenticator or unused
          backup code verified within five minutes. Verification does not grant
          additional permissions or extend your session.
        </p>
        {error && (
          <p className="staff-error" role="alert">
            {error}
          </p>
        )}
        <form className="staff-form" onSubmit={submit}>
          {step === "password" ? (
            <div className="staff-field">
              <label htmlFor={`${id}-password`}>
                Your current password or passphrase
              </label>
              <input
                id={`${id}-password`}
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
                required
                disabled={busy}
              />
            </div>
          ) : (
            <>
              <div className="staff-field">
                <label htmlFor={`${id}-method`}>
                  Second verification factor
                </label>
                <select
                  id={`${id}-method`}
                  value={method}
                  onChange={(event) => {
                    setMethod(event.target.value);
                    setCode("");
                  }}
                  disabled={busy}
                >
                  <option value="totp">Authenticator code</option>
                  <option value="backup">Unused single-use backup code</option>
                </select>
              </div>
              <div className="staff-field">
                <label htmlFor={`${id}-code`}>
                  {method === "totp"
                    ? "Authenticator code"
                    : "Single-use backup code"}
                </label>
                <input
                  id={`${id}-code`}
                  type={method === "backup" ? "password" : "text"}
                  inputMode={method === "totp" ? "numeric" : "text"}
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  autoComplete="one-time-code"
                  required
                  disabled={busy}
                  maxLength={method === "totp" ? 6 : 128}
                  pattern={method === "totp" ? "[0-9]{6}" : undefined}
                  spellCheck={false}
                  autoCapitalize="none"
                />
              </div>
              <p className="staff-help">
                A backup code is consumed normally. Incorrect verification does
                not by itself sign you out; expiry and account revocation still
                apply.
              </p>
            </>
          )}
          <div className="staff-actions">
            <button
              className="staff-button staff-button-primary"
              type="submit"
              disabled={busy}
            >
              {busy
                ? "Verifying…"
                : step === "password"
                  ? "Verify password"
                  : "Verify and continue action"}
            </button>
            <button
              className="staff-button"
              type="button"
              disabled={busy}
              onClick={onCancel}
            >
              Cancel action
            </button>
          </div>
          {step === "factor" && (
            <button
              className="staff-button"
              type="button"
              disabled={busy}
              onClick={() => {
                setStep("password");
                setPassword("");
                setCode("");
                setError("");
              }}
            >
              Restart verification
            </button>
          )}
          {step === "factor" && (
            <p className="staff-help">
              Restarting replaces the unfinished verification challenge only
              after another password check. Accumulated failures and cooldowns
              are never reset.
            </p>
          )}
        </form>
      </section>
    </div>
  );
}
