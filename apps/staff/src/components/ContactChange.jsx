import { useCallback, useEffect, useId, useRef, useState } from "react";
import EmailInput from "./EmailInput.jsx";
import {
  normalizedEmail,
  EMAIL_INPUT_MESSAGE,
} from "../../shared/contact-input.js";
import {
  isAccessError,
  managementErrorMessage,
  handoffExpiry,
} from "../lib/staffManagement.js";

export default function ContactChange({
  api,
  revision,
  roles = [],
  onSaved,
  onRefresh,
  onError,
  onPendingChange,
  onClose,
  returnFocus,
}) {
  const id = useId(),
    live = useRef(true),
    heading = useRef(null);
  const dialog = useRef(null),
    inFlight = useRef(false),
    identityExpiry = useRef(null);
  const savedResult = useRef(null),
    cancelRef = useRef(null);
  const administrative = roles.some((role) =>
    ["Admin", "System Admin", "Clinic Admin", "Lab Admin"].includes(role),
  );
  const [status, setStatus] = useState(null),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true);
  const [phase, setPhase] = useState("start"),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const callbacks = useRef({ onSaved, onRefresh, onError, onPendingChange });
  callbacks.current = { onSaved, onRefresh, onError, onPendingChange };
  const [clock, setClock] = useState(Date.now());
  const report = useCallback((failure) => {
    setError(managementErrorMessage(failure));
    if (isAccessError(failure) && !String(failure.code).includes("unavailable"))
      callbacks.current.onError?.(failure);
  }, []);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.contactStatus();
      if (live.current) {
        setStatus(result);
        setPhase(result.pending ? "code" : "start");
      }
    } catch (failure) {
      if (live.current) report(failure);
    } finally {
      if (live.current) setLoading(false);
    }
  }, [api, report]);
  useEffect(() => {
    live.current = true;
    void load();
    return () => {
      live.current = false;
    };
  }, [load]);
  useEffect(() => {
    dialog.current?.showModal();
    heading.current?.focus({ preventScroll: true });
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => {
      clearInterval(timer);
      dialog.current?.close();
      returnFocus?.current?.focus({ preventScroll: true });
    };
  }, [returnFocus]);
  async function act(callback, refreshOnFailure = true) {
    if (inFlight.current || !live.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    callbacks.current.onPendingChange?.(true);
    try {
      await callback();
    } catch (failure) {
      if (live.current) {
        report(failure);
        if (
          refreshOnFailure &&
          !["contact_email_already_verified", "contact_email_in_use"].includes(
            failure.code,
          ) &&
          phase !== "saved" &&
          !(
            phase === "identity" &&
            failure.code === "contact_verification_failed"
          )
        )
          await load();
        if (phase === "code") await callbacks.current.onRefresh?.();
      }
    } finally {
      inFlight.current = false;
      if (live.current) {
        setBusy(false);
        heading.current?.focus({ preventScroll: true });
      }
      callbacks.current.onPendingChange?.(false);
    }
  }
  function begin(event) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    if (inFlight.current) return;
    if (!normalizedEmail(String(data.get("destination") ?? ""))) {
      setError(EMAIL_INPUT_MESSAGE);
      event.currentTarget.elements.namedItem("password").value = "";
      return;
    }
    const payload = {
      type: "email",
      destination: String(data.get("destination") ?? ""),
      password: String(data.get("password") ?? ""),
      expectedRevision: revision,
    };
    event.currentTarget.reset(); // Do not retain passwords in component state.
    void act(async () => {
      let result;
      try {
        result = await api.startContactIdentity(payload);
      } finally {
        payload.password = "";
      }
      if (!live.current) return;
      if (result.kind === "contact_identity") {
        identityExpiry.current = result.expiresAt;
        setPhase("identity");
      } else await load();
    });
  }
  function identify(event) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    if (inFlight.current) return;
    const payload = {
      type: "email",
      code: String(data.get("factor") ?? ""),
      method: String(data.get("method") ?? "totp"),
    };
    event.currentTarget.reset();
    void act(async () => {
      try {
        await api.completeContactIdentity(payload);
      } finally {
        payload.code = "";
      }
      if (live.current) await load();
    });
  }
  function verifyCode(event) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    if (inFlight.current) return;
    const payload = {
      type: "email",
      code: String(data.get("code") ?? "").trim(),
    };
    event.currentTarget.reset();
    void act(async () => {
      let result;
      try {
        result = await api.completeContactChange(payload);
      } finally {
        payload.code = "";
      }
      if (!live.current) return;
      savedResult.current = result;
      setPhase("saved");
      setNotice(
        result.testOnly
          ? "Automated TEST result only. No real contact was verified."
          : "Email verified and saved. Recovery remains unavailable.",
      );
      if (await callbacks.current.onSaved?.(result)) onClose?.();
    });
  }
  function cancel() {
    if (inFlight.current) return;
    for (const input of dialog.current?.querySelectorAll(
      'input[type="password"], input[name="code"]',
    ) ?? [])
      input.value = "";
    if (phase === "saved") {
      onClose?.();
      return;
    }
    void act(async () => {
      const result = await api.cancelContactChange({ type: "email" });
      if (result.cancelled !== true)
        throw Object.assign(
          new Error(
            "Cancellation was not confirmed. Your dialog remains open; retry Cancel.",
          ),
          { code: "contact_cancel_failed" },
        );
      if (live.current) onClose?.();
    }, false);
  }
  cancelRef.current = cancel;
  const expiresAt =
    phase === "identity"
      ? identityExpiry.current
      : phase === "code"
        ? status?.pending?.expiresAt
        : null;
  const expired = expiresAt && clock >= Date.parse(expiresAt);
  useEffect(() => {
    if (expired)
      for (const input of dialog.current?.querySelectorAll(
        'input[type="password"], input[name="code"]',
      ) ?? [])
        input.value = "";
  }, [expired]);
  return (
    <dialog
      ref={dialog}
      className="staff-email-dialog staff-verification-dialog"
      aria-modal="true"
      aria-labelledby={`${id}-heading`}
      aria-describedby={`${id}-description`}
      onCancel={(event) => {
        event.preventDefault();
        cancelRef.current();
      }}
    >
      <h2 ref={heading} id={`${id}-heading`} tabIndex={-1}>
        Change email
      </h2>
      <p className="staff-eyebrow" role="status">
        {phase === "start"
          ? "1 · Proposed email and current password"
          : phase === "identity"
            ? "2 · Fresh administrative MFA"
            : phase === "saved"
              ? "Email saved · Refresh profile"
              : `${administrative ? "3" : "2"} · Verify the delivered email code`}
      </p>
      <p id={`${id}-description`} className="staff-help">
        Your saved email stays unchanged until you confirm the code delivered to
        the proposed address. Current password
        {administrative ? " and fresh administrative MFA" : ""} confirm your
        identity, not ownership of that address.
      </p>
      <p className="staff-help">
        Phone changes are unavailable. Live WhatsApp delivery has not been
        configured or tested. Email verification does not enable password
        recovery.
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
      {loading ? (
        <p role="status">Checking contact delivery…</p>
      ) : !status ? (
        <button className="staff-button" onClick={() => void load()}>
          Retry contact status
        </button>
      ) : (
        <>
          {!status.emailReady && (
            <div className="staff-state">
              <p>{status.message}</p>
              <button
                className="staff-button"
                type="button"
                disabled={busy}
                onClick={() => void load()}
              >
                Recheck email setup
              </button>
            </div>
          )}
          {phase === "start" && status.emailReady && (
            <form className="staff-form" onSubmit={begin}>
              <EmailInput
                id={`${id}-destination`}
                name="destination"
                label="Proposed email address"
                disabled={busy}
              />
              <div className="staff-field">
                <label htmlFor={`${id}-password`}>
                  Your current password or passphrase
                </label>
                <input
                  id={`${id}-password`}
                  name="password"
                  type="password"
                  required
                  disabled={busy}
                  autoComplete="off"
                />
              </div>
              <button
                className="staff-button staff-button-primary"
                type="submit"
                disabled={busy}
              >
                {busy ? "Checking…" : "Confirm my identity"}
              </button>
            </form>
          )}
          {expired && (
            <p className="staff-error" role="alert">
              This request has expired. Cancel and start a new request. Your
              saved contact is unchanged.
            </p>
          )}
          {phase === "identity" && (
            <form className="staff-form" onSubmit={identify}>
              <p className="staff-help">
                Enter a fresh authenticator code (a code already used to sign in
                cannot be reused), or an unused backup code. The identity
                challenge expires after five minutes.
              </p>
              <div className="staff-field">
                <label htmlFor={`${id}-method`}>Identity factor</label>
                <select
                  id={`${id}-method`}
                  name="method"
                  disabled={busy}
                  onChange={(event) => {
                    event.currentTarget.form.elements.namedItem(
                      "factor",
                    ).value = "";
                  }}
                >
                  <option value="totp">Authenticator</option>
                  <option value="backup">Unused backup code</option>
                </select>
              </div>
              <div className="staff-field">
                <label htmlFor={`${id}-factor`}>
                  Identity verification code
                </label>
                <input
                  id={`${id}-factor`}
                  name="factor"
                  type="password"
                  required
                  disabled={busy || expired}
                  autoComplete="off"
                />
              </div>
              <button
                className="staff-button staff-button-primary"
                type="submit"
                disabled={busy || expired}
              >
                {busy ? "Checking…" : "Verify identity and send email code"}
              </button>
            </form>
          )}
          {phase === "code" && status.pending && (
            <>
              <div className="staff-state">
                <p>
                  Pending email: <strong>{status.pending.destination}</strong>
                </p>
                <p>
                  Original expiry: {handoffExpiry(status.pending.expiresAt)}.
                  Saved contact has not changed.
                </p>
                {status.pending.testOnly && (
                  <p>Automated TEST delivery only — not real verification.</p>
                )}
                {status.pending.state !== "pending" && (
                  <p>
                    Delivery failed, was interrupted or is still in progress. No
                    contact has been verified. Wait before resending, or cancel
                    and start again.
                  </p>
                )}
              </div>
              {status.pending.state === "pending" && (
                <form className="staff-form" onSubmit={verifyCode}>
                  <div className="staff-field">
                    <label htmlFor={`${id}-code`}>
                      Eight-digit code from the proposed email
                    </label>
                    <input
                      id={`${id}-code`}
                      name="code"
                      type="text"
                      required
                      pattern="[0-9]{8}"
                      inputMode="numeric"
                      maxLength={8}
                      disabled={busy || expired}
                      autoComplete="one-time-code"
                      spellCheck={false}
                    />
                  </div>
                  <button
                    className="staff-button staff-button-primary"
                    type="submit"
                    disabled={busy || expired}
                  >
                    {busy ? "Verifying…" : "Verify email and save"}
                  </button>
                </form>
              )}
              <p className="staff-help">
                Resend available after {handoffExpiry(status.pending.resendAt)};{" "}
                {status.pending.resendsRemaining} resends remaining. Resending
                never extends expiry.
              </p>
              <button
                className="staff-button"
                type="button"
                disabled={
                  busy ||
                  expired ||
                  status.pending.resendsRemaining <= 0 ||
                  clock < Date.parse(status.pending.resendAt)
                }
                onClick={() =>
                  void act(async () => {
                    await api.resendContactCode({ type: "email" });
                    await load();
                  })
                }
              >
                Resend email code
              </button>
              <button
                className="staff-button"
                type="button"
                disabled={busy}
                onClick={() => void load()}
              >
                Refresh pending status
              </button>
            </>
          )}
          {phase === "saved" && (
            <>
              <p className="staff-help">
                Email has been saved, but refreshing your profile has not yet
                succeeded. Your address draft is preserved; do not submit the
                email code again.
              </p>
              <button
                className="staff-button"
                type="button"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    if (await callbacks.current.onSaved?.(savedResult.current))
                      onClose?.();
                  }, false)
                }
              >
                Retry profile refresh
              </button>
            </>
          )}
        </>
      )}
      <button
        className="staff-button"
        type="button"
        disabled={busy}
        onClick={cancel}
      >
        {phase === "saved" ? "Close email dialog" : "Cancel email change"}
      </button>
    </dialog>
  );
}
