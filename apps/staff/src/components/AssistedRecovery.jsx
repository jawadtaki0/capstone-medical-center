import { useEffect, useId, useRef, useState } from "react";
import { observeChallenge, sessionTiming } from "../lib/activity.js";

function PrivateHandoff({ result, api, onClose, returnFocus }) {
  const dialog = useRef(null),
    heading = useRef(null),
    id = useId();
  const [secret, setSecret] = useState(result.handoff),
    [message, setMessage] = useState("");
  useEffect(() => {
    let live = true;
    const deadline = observeChallenge(
      {
        serverNow: result.serverNow,
        expiresAt: result.displayExpiresAt,
      },
      result.observedAt,
    );
    dialog.current.showModal();
    heading.current.focus();
    const tick = () => {
      if (sessionTiming(deadline).expired) {
        setSecret("");
        setMessage(
          "Private display expired. The handed-over token retains its original deadline.",
        );
      }
    };
    const timer = setInterval(tick, 500);
    const statuses = setInterval(() => {
      void api.sessionStatus().catch(() => {
        if (live) {
          setSecret("");
          setMessage("Authorization unavailable. Private display cleared.");
        }
      });
    }, 5000);
    window.addEventListener("focus", tick);
    document.addEventListener("visibilitychange", tick);
    return () => {
      live = false;
      clearInterval(timer);
      clearInterval(statuses);
      window.removeEventListener("focus", tick);
      document.removeEventListener("visibilitychange", tick);
      dialog.current?.close();
      returnFocus.current?.focus();
    };
  }, [api, result, returnFocus]);
  return (
    <dialog
      className="staff-verification-dialog staff-email-dialog"
      ref={dialog}
      aria-labelledby={`${id}-title`}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <h2 ref={heading} tabIndex={-1} id={`${id}-title`}>
        Private recovery handoff
      </h2>
      <p>
        Scope: <strong>{result.scope}</strong>. Hand this token to the employee
        in person. They choose their own password privately.
      </p>
      {secret && <p className="staff-private-key">{secret}</p>}
      <p role="status">{message}</p>
      <p className="staff-help">
        Do not screenshot, email or log this token. Expires{" "}
        {new Date(result.expiresAt).toLocaleString("en-GB", {
          timeZone: "Asia/Beirut",
        })}{" "}
        (Asia/Beirut). Closing hides the display, not the handed-over
        authorization.
      </p>
      <button className="staff-button" onClick={onClose}>
        Close private display
      </button>
    </dialog>
  );
}

export default function AssistedRecovery({
  account,
  api,
  onSensitiveAction,
  onError,
}) {
  const id = useId(),
    button = useRef(null),
    live = useRef(true),
    pending = useRef(false);
  const [scope, setScope] = useState("password"),
    [purpose, setPurpose] = useState(""),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [result, setResult] = useState(null),
    [error, setError] = useState(""),
    [revocationConfirmed, setRevocationConfirmed] = useState(false),
    [notice, setNotice] = useState("");
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  async function submit(event) {
    event.preventDefault();
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      let observedAt;
      const authorized = await onSensitiveAction(() => {
        observedAt = Date.now();
        return api.assistStaffRecovery({
          accountId: account.id,
          version: account.version,
          scope,
          purpose,
          identityConfirmed: confirmed,
          confirmed: true,
        });
      });
      if (live.current) setResult({ ...authorized, observedAt });
    } catch (failure) {
      if (live.current) {
        setError(failure.message);
        onError?.(failure);
      }
    } finally {
      pending.current = false;
      if (live.current) setBusy(false);
    }
  }
  async function revoke() {
    if (pending.current || !revocationConfirmed) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      await onSensitiveAction(() =>
        api.revokeStaffRecovery({
          accountId: account.id,
          version: account.version,
          confirmed: true,
        }),
      );
      if (live.current) {
        setResult(null);
        setNotice(
          "Private assisted handoffs revoked. Saved factors are not restored or reset.",
        );
      }
    } catch (failure) {
      if (live.current) {
        setError(failure.message);
        onError?.(failure);
      }
    } finally {
      pending.current = false;
      if (live.current) setBusy(false);
    }
  }
  return (
    <section className="staff-state" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`}>Authorize in-person recovery</h3>
      <p className="staff-help">
        Another Admin only. Password-only recovery still requires the employee's
        existing administrative MFA. MFA-only recovery requires their current
        password. Combined recovery explicitly replaces both.
      </p>
      <form className="staff-form" onSubmit={submit}>
        <div className="staff-field">
          <label htmlFor={`${id}-scope`}>Recovery scope</label>
          <select
            id={`${id}-scope`}
            value={scope}
            onChange={(event) => setScope(event.target.value)}
            disabled={busy}
          >
            <option value="password">Password only</option>
            <option value="mfa">Authenticator only</option>
            <option value="both">Password and authenticator</option>
          </select>
        </div>
        <div className="staff-field">
          <label htmlFor={`${id}-purpose`}>
            Purpose (no private documents or secrets)
          </label>
          <input
            id={`${id}-purpose`}
            value={purpose}
            onChange={(event) => setPurpose(event.target.value)}
            required
            maxLength={200}
            disabled={busy}
          />
        </div>
        <label className="staff-check">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
            required
            disabled={busy}
          />{" "}
          I confirmed this employee’s identity in person
        </label>
        {error && (
          <p className="staff-error" role="alert">
            {error}
          </p>
        )}
        <button
          ref={button}
          className="staff-button"
          disabled={busy || !confirmed}
        >
          {busy ? "Authorizing…" : "Authorize private recovery handoff"}
        </button>
      </form>
      <label className="staff-check">
        <input
          type="checkbox"
          checked={revocationConfirmed}
          onChange={(event) => setRevocationConfirmed(event.target.checked)}
          disabled={busy}
        />
        Revoke this employee's unused assisted handoffs and derived recovery
        authorization. This does not undo a committed password or factor
        replacement.
      </label>
      <button
        className="staff-button"
        type="button"
        disabled={busy || !revocationConfirmed}
        onClick={() => void revoke()}
      >
        Revoke private recovery handoffs
      </button>
      {notice && <p role="status">{notice}</p>}
      {result && (
        <PrivateHandoff
          result={result}
          api={api}
          returnFocus={button}
          onClose={() => setResult(null)}
        />
      )}
    </section>
  );
}
