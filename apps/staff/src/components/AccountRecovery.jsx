import { useEffect, useId, useRef, useState } from "react";
import QRCode from "qrcode";
import { observeChallenge, sessionTiming } from "../lib/activity.js";

export default function AccountRecovery({
  api,
  onClose,
  onComplete,
  returnFocus,
}) {
  const id = useId(),
    dialog = useRef(null),
    heading = useRef(null),
    generation = useRef(0),
    live = useRef(true),
    deadline = useRef(null),
    pending = useRef(false),
    cancelling = useRef(false);
  const [phase, setPhase] = useState("choose"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [username, setUsername] = useState(""),
    [password, setPassword] = useState(""),
    [handoff, setHandoff] = useState(""),
    [code, setCode] = useState(""),
    [method, setMethod] = useState("totp"),
    [newPassword, setNewPassword] = useState(""),
    [confirmation, setConfirmation] = useState(""),
    [seed, setSeed] = useState(null),
    [qr, setQr] = useState(""),
    [backups, setBackups] = useState([]);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const [scope, setScope] = useState("password");
  function clear() {
    setPassword("");
    setHandoff("");
    setCode("");
    setNewPassword("");
    setConfirmation("");
    setSeed(null);
    setQr("");
    setBackups([]);
  }
  function current(expected = generation.current) {
    if (!live.current || expected !== generation.current) return false;
    if (deadline.current && sessionTiming(deadline.current).expired) {
      generation.current++;
      deadline.current = null;
      clear();
      setBusy(false);
      setPhase("expired");
      setError(
        "Recovery authorization expired. Private entries were cleared. If a save was already submitted, sign in to check its outcome. Interrupted replacement requires authorized resumption; old factors are not restored.",
      );
      void api.cancelRecovery().catch(() => {});
      return false;
    }
    return true;
  }
  const check = useRef(current);
  check.current = current;
  useEffect(() => {
    live.current = true;
    dialog.current.showModal();
    heading.current?.focus();
    const tick = () => check.current();
    const timer = setInterval(tick, 500);
    const statuses = setInterval(() => {
      if (
        !check.current() ||
        !deadline.current ||
        ["email", "expired"].includes(phaseRef.current)
      )
        return;
      const expected = generation.current;
      void api.recoveryStatus().catch((failure) => {
        if (!check.current(expected)) return;
        generation.current++;
        clear();
        deadline.current = null;
        setPhase("expired");
        setError(failure.message);
      });
    }, 5000);
    ["focus", "pageshow"].forEach((name) =>
      window.addEventListener(name, tick),
    );
    document.addEventListener("visibilitychange", tick);
    dialog.current.addEventListener("keydown", tick, true);
    return () => {
      live.current = false;
      generation.current++;
      deadline.current = null;
      clearInterval(timer);
      clearInterval(statuses);
      ["focus", "pageshow"].forEach((name) =>
        window.removeEventListener(name, tick),
      );
      document.removeEventListener("visibilitychange", tick);
      dialog.current?.removeEventListener("keydown", tick, true);
      dialog.current?.close();
      returnFocus?.current?.focus();
    };
  }, [api, returnFocus]);
  useEffect(() => {
    heading.current?.focus();
  }, [phase]);
  async function accept(result, expected, startedAt) {
    if (!current(expected)) return;
    if (result.completed) {
      clear();
      generation.current++;
      onComplete(result.message);
      return;
    }
    if (result.expiresAt)
      deadline.current = observeChallenge(result, startedAt);
    if (result.scope) setScope(result.scope);
    if (!current(expected)) return;
    const next = result.kind?.replace("recovery_", "");
    setCode("");
    setPassword("");
    setHandoff("");
    if (next === "enroll") {
      setPhase("enroll");
      const enrollment = await api.recoveryEnrollment();
      if (!current(expected)) return;
      setSeed(enrollment.secret);
      try {
        const image = await QRCode.toDataURL(enrollment.uri, {
          width: 220,
          margin: 2,
        });
        if (current(expected)) setQr(image);
      } catch {
        if (current(expected))
          setNotice(
            "QR rendering unavailable. Enter the displayed setup key in your authenticator.",
          );
      }
    } else if (next === "backups") {
      setSeed(null);
      setQr("");
      setPhase("backups");
      const resultBackups = result.backupCodes
        ? result
        : await api.recoveryBackups();
      if (current(expected)) setBackups(resultBackups.backupCodes);
    } else if (next) setPhase(next);
    if (result.message) setNotice(result.message);
  }
  async function run(operation) {
    if (pending.current || !current()) return;
    pending.current = true;
    setBusy(true);
    setError("");
    const expected = generation.current,
      startedAt = Date.now();
    try {
      await accept(await operation(), expected, startedAt);
    } catch (failure) {
      if (current(expected)) {
        setError(failure.message);
        if (["recovery_expired", "ACTION_SUPERSEDED"].includes(failure.code)) {
          clear();
          setPhase("expired");
        }
        // Busy refusals deliberately preserve all valid form entries.
      }
    } finally {
      pending.current = false;
      if (current(expected)) setBusy(false);
    }
  }
  async function close() {
    if (cancelling.current) return;
    cancelling.current = true;
    generation.current++;
    clear();
    setBusy(true);
    try {
      await api.cancelRecovery();
      onClose();
    } catch (failure) {
      setError(
        `Cancellation could not be confirmed: ${failure.message} Retry Cancel. Saved passwords and factors will not be restored.`,
      );
    } finally {
      if (live.current) setBusy(false);
      cancelling.current = false;
    }
  }
  function submit(event) {
    event.preventDefault();
    if (phase === "username")
      return run(() => api.requestRecovery({ username }));
    if (phase === "email") return run(() => api.verifyRecovery({ code }));
    if (phase === "mfa")
      return run(() => api.verifyRecoveryFactor({ method, code }));
    if (phase === "handoff")
      return run(() => api.redeemRecovery({ username, handoff, password }));
    if (phase === "self" || phase === "resume")
      return run(() =>
        api.proveRecoveryPassword({
          username,
          password,
          method,
          code,
          resume: phase === "resume",
        }),
      );
    if (phase === "ready")
      return run(() =>
        scope === "mfa"
          ? api.replaceRecoveryMfa()
          : api.saveRecoveryPassword({ newPassword, confirmation }),
      );
    if (phase === "enroll") return run(() => api.confirmRecoveryMfa({ code }));
    if (phase === "backups") return run(() => api.acknowledgeRecoveryBackups());
  }
  const field = (name, label, value, setter, type = "text", extra = {}) => (
    <div className="staff-field">
      <label htmlFor={`${id}-${name}`}>{label}</label>
      <input
        id={`${id}-${name}`}
        type={type}
        value={value}
        onChange={(event) => setter(event.target.value)}
        disabled={busy}
        required
        {...extra}
      />
    </div>
  );
  return (
    <dialog
      className="staff-verification-dialog staff-email-dialog"
      ref={dialog}
      aria-labelledby={`${id}-title`}
      onCancel={(event) => {
        event.preventDefault();
        void close();
      }}
    >
      <h2 id={`${id}-title`} ref={heading} tabIndex={-1}>
        Recover staff account access
      </h2>
      <p className="staff-help">
        Recovery does not enable or reactivate accounts. Administrators cannot
        choose your password.
      </p>
      {error && (
        <p className="staff-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="staff-notice" role="status">
          {notice}
        </p>
      )}
      {phase === "choose" ? (
        <div className="staff-actions">
          <button className="staff-button" onClick={() => setPhase("username")}>
            Forgot password — verified email
          </button>
          <button className="staff-button" onClick={() => setPhase("self")}>
            Replace authenticator using password and backup
          </button>
          <button className="staff-button" onClick={() => setPhase("handoff")}>
            Use private recovery handoff
          </button>
          <button className="staff-button" onClick={() => setPhase("resume")}>
            Resume new-backup acknowledgement
          </button>
        </div>
      ) : (
        phase !== "expired" && (
          <form className="staff-form" onSubmit={submit}>
            {["username", "handoff", "self", "resume"].includes(phase) &&
              field(
                "username",
                "Assigned username",
                username,
                setUsername,
                "text",
                { autoComplete: "username", autoCapitalize: "none" },
              )}
            {phase === "handoff" && (
              <>
                {field(
                  "handoff",
                  "Private recovery token",
                  handoff,
                  setHandoff,
                  "password",
                  { autoComplete: "off" },
                )}
                {field(
                  "password",
                  "Current password (required for MFA-only recovery; otherwise leave blank)",
                  password,
                  setPassword,
                  "password",
                  { required: false, autoComplete: "current-password" },
                )}
              </>
            )}
            {["self", "resume"].includes(phase) &&
              field(
                "password",
                "Current password",
                password,
                setPassword,
                "password",
                { autoComplete: "current-password" },
              )}
            {["mfa", "self", "resume"].includes(phase) && (
              <div className="staff-field">
                <label htmlFor={`${id}-method`}>Verification method</label>
                <select
                  id={`${id}-method`}
                  value={method}
                  onChange={(event) => {
                    setMethod(event.target.value);
                    setCode("");
                  }}
                  disabled={busy}
                >
                  <option value="totp">Authenticator</option>
                  <option value="backup">Unused backup code</option>
                </select>
              </div>
            )}
            {["email", "mfa", "self", "resume", "enroll"].includes(phase) &&
              field(
                "code",
                phase === "email"
                  ? "Eight-digit email recovery code"
                  : phase === "enroll"
                    ? "New authenticator code"
                    : "Authenticator or unused backup code",
                code,
                setCode,
                "text",
                {
                  autoComplete: "one-time-code",
                  inputMode:
                    phase === "email" || method === "totp" ? "numeric" : "text",
                  ...(phase === "email"
                    ? { pattern: "[0-9]{8}", maxLength: 8 }
                    : {}),
                },
              )}
            {phase === "ready" && scope !== "mfa" && (
              <>
                {field(
                  "new",
                  "New password or passphrase",
                  newPassword,
                  setNewPassword,
                  "password",
                  {
                    autoComplete: "new-password",
                    minLength: 15,
                    maxLength: 128,
                  },
                )}
                {field(
                  "confirmation",
                  "Confirm new password exactly",
                  confirmation,
                  setConfirmation,
                  "password",
                  { autoComplete: "new-password" },
                )}
                <p className="staff-help">
                  15–128 characters. Every recorded past password is refused.
                </p>
              </>
            )}
            {phase === "enroll" && (
              <section aria-label="Private replacement authenticator">
                <p>
                  Old factors and sessions were revoked. Store this new
                  authenticator privately.
                </p>
                {qr && (
                  <img
                    className="staff-qr"
                    src={qr}
                    alt="Replacement authenticator setup QR"
                  />
                )}
                {seed && <p className="staff-private-key">{seed}</p>}
              </section>
            )}
            {phase === "backups" && (
              <section>
                <p>
                  Store these private backup codes safely. Do not screenshot
                  them or include them in reports.
                </p>
                <ul className="staff-backup-list">
                  {backups.map((value) => (
                    <li key={value}>{value}</li>
                  ))}
                </ul>
              </section>
            )}
            {phase === "ready" && scope === "mfa" && (
              <p className="staff-help">
                Confirm replacement will revoke the old authenticator, backups
                and sessions. You must complete new enrollment before access.
              </p>
            )}
            <button
              className="staff-button staff-button-primary"
              type="submit"
              disabled={busy}
            >
              {busy
                ? "Checking…"
                : phase === "backups"
                  ? "I stored my new backup codes"
                  : phase === "ready"
                    ? scope === "mfa"
                      ? "Confirm authenticator replacement"
                      : "Save new password"
                    : "Continue"}
            </button>
            {phase === "email" && (
              <button
                className="staff-button"
                type="button"
                disabled={busy}
                onClick={() => run(() => api.resendRecovery())}
              >
                Resend code (original expiry unchanged)
              </button>
            )}
          </form>
        )
      )}
      <button
        className="staff-button"
        type="button"
        onClick={() => void close()}
      >
        Cancel
      </button>
    </dialog>
  );
}
