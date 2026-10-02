import { useCallback, useEffect, useRef, useState } from "react";
import { SignInForm, SetupForm } from "./components/AuthForms.jsx";
import { BackupCodesPanel, MfaPanel } from "./components/MfaPanel.jsx";
import Workspace from "./components/Workspace.jsx";
import { observeSession, sessionTiming, shouldReportActivity } from "./lib/activity.js";

export default function App({ api = window.staffApi }) {
  const [connection, setConnection] = useState(api ? "checking" : "missing-bridge");
  const [setupAvailable, setSetupAvailable] = useState(false);
  const [step, setStep] = useState("sign-in");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [user, setUser] = useState(null);
  const [session, setSession] = useState(null);
  const [workspace, setWorkspace] = useState(null);
  const [backupCodes, setBackupCodes] = useState([]);
  const [now, setNow] = useState(Date.now);
  const stepRef = useRef(step);
  const generation = useRef(0);
  const mainRef = useRef(null);
  const authorityPending = useRef(false);
  const activityPending = useRef(false);
  const lastActivity = useRef(-Infinity);
  stepRef.current = step;

  const forgetAccess = useCallback(() => {
    generation.current += 1;
    setUser(null); setSession(null); setWorkspace(null); setBackupCodes([]); setStep("sign-in");
    setBusy(false);
    lastActivity.current = -Infinity;
  }, []);

  const handleError = useCallback((failure, context = "action") => {
    const code = String(failure?.code ?? "").toLowerCase();
    const message = typeof failure?.message === "string" ? failure.message : "The action could not be completed. Please try again.";
    if (context === "connection" || code.includes("unavailable") || code.includes("network") || failure?.status === 503) {
      forgetAccess();
      setConnection("unavailable");
      setError("The local staff authority is unavailable. Access is blocked until it is available again.");
      // Main forgets its token even when the remote revocation cannot be sent.
      void api?.signOut().catch(() => {});
      return;
    }
    if (context === "session" || code.includes("expired") || code.includes("revoked")) {
      forgetAccess();
      void api?.signOut().catch(() => {});
    }
    setError(message);
  }, [api, forgetAccess]);

  const updateSession = useCallback((result) => {
    if (result?.user) setUser(result.user);
    if (result?.session) setSession(observeSession(result.session));
  }, []);

  const checkAuthority = useCallback(async () => {
    if (!api || authorityPending.current) return;
    const current = generation.current;
    authorityPending.current = true;
    try {
      const health = await api.status();
      if (current !== generation.current) return;
      if (health.status !== "ok" || health.database !== "connected") {
        const failure = new Error("The local staff authority is unavailable.");
        failure.code = "authority_unavailable";
        throw failure;
      }
      if (stepRef.current === "sign-in") {
        const setup = await api.setupStatus();
        if (current !== generation.current) return;
        setSetupAvailable(setup.available === true);
      }
      setConnection("connected");
    } catch (failure) { if (current === generation.current) handleError(failure, "connection"); }
    finally { authorityPending.current = false; }
  }, [api, handleError]);

  useEffect(() => {
    void checkAuthority();
    const timer = setInterval(() => { void checkAuthority(); }, 15_000);
    return () => clearInterval(timer);
  }, [checkAuthority]);

  useEffect(() => {
    const heading = mainRef.current?.querySelector("h1");
    if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
  }, [connection, step]);

  async function perform(action) {
    const current = generation.current;
    setBusy(true); setError("");
    const isCurrent = () => current === generation.current;
    try { await action(isCurrent); } catch (failure) { if (isCurrent()) handleError(failure); }
    finally { if (isCurrent()) setBusy(false); }
  }

  function authenticate(action) {
    return perform(async (isCurrent) => {
      const result = await action();
      if (isCurrent()) await acceptAuthentication(result);
    });
  }

  async function openWorkspace(result) {
    const current = generation.current;
    const identity = result?.user && result?.session ? result : await api.sessionStatus();
    const authorizedWorkspace = await api.workspace();
    if (current !== generation.current) return;
    if (!identity.user || !identity.session) throw new Error("Sign in again to verify your session.");
    updateSession(identity); setWorkspace(authorizedWorkspace); setBackupCodes([]); setStep("workspace");
    lastActivity.current = -Infinity;
  }

  async function acceptAuthentication(result) {
    if (!result || typeof result !== "object") throw new Error("The local server returned an incomplete sign-in response. Try again.");
    if (result.kind === "enroll") { setSetupAvailable(false); setStep("enroll"); }
    else if (result.kind === "mfa") setStep("mfa");
    else if (result.needsBackupAcknowledgement || result.backupCodes?.length) {
      updateSession(result); setBackupCodes(result.backupCodes ?? []); setStep("backup-codes");
    } else await openWorkspace(result);
  }

  function returnToSignIn() {
    forgetAccess(); setError("");
    void api.signOut().catch(() => {});
    void checkAuthority();
  }

  const reportActivity = useCallback((event) => {
    const timestamp = Date.now();
    const observation = { type: event.type, isTrusted: event.isTrusted, visible: !document.hidden, focused: document.hasFocus() };
    if (stepRef.current !== "workspace" || activityPending.current || !shouldReportActivity(observation, lastActivity.current, timestamp)) return;
    lastActivity.current = timestamp;
    activityPending.current = true;
    const current = generation.current;
    api.activity().then(async (result) => result?.session ? result : api.sessionStatus()).then((result) => {
      if (current === generation.current && stepRef.current === "workspace") updateSession(result);
    }).catch((failure) => { if (current === generation.current) handleError(failure, "session"); })
      .finally(() => { activityPending.current = false; });
  }, [api, handleError, updateSession]);

  useEffect(() => {
    if (step !== "workspace" || connection !== "connected") return;
    const types = ["pointerdown", "touchstart", "keydown", "input", "wheel"];
    types.forEach((type) => document.addEventListener(type, reportActivity, { capture: true, passive: true }));
    let pending = false;
    const timer = setInterval(() => {
      if (pending) return;
      pending = true;
      const current = generation.current;
      api.sessionStatus().then((result) => { if (current === generation.current) updateSession(result); })
        .catch((failure) => { if (current === generation.current) handleError(failure, "session"); })
        .finally(() => { pending = false; });
    }, 15_000);
    return () => { clearInterval(timer); types.forEach((type) => document.removeEventListener(type, reportActivity, true)); };
  }, [step, connection, api, reportActivity, updateSession, handleError]);

  useEffect(() => {
    if (step !== "workspace") return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [step]);

  const timing = sessionTiming(session, now);
  useEffect(() => {
    if (step === "workspace" && timing.expired) {
      forgetAccess(); setError("Your session expired. Sign in again to continue.");
      void api.signOut().catch(() => {});
    }
  }, [step, timing.expired, api, forgetAccess]);

  return <div className="staff-app">
    <a className="staff-skip-link" href="#staff-main">Skip to content</a>
    <header className="staff-header"><div className="staff-brand"><span aria-hidden="true" className="staff-brand-mark">+</span><span>Cedar Staff<small>ACCESS FOUNDATION · SYNTHETIC DEVELOPMENT</small></span></div><div className="staff-header-actions"><span className="staff-connection" role="status">{connection === "connected" ? "Local server connected" : connection === "checking" ? "Checking local server…" : "Access unavailable"}</span>{step === "workspace" && <button className="staff-button" type="button" disabled={busy} onClick={() => perform(async () => { forgetAccess(); await api.signOut(); })}>Sign out</button>}</div></header>
    <main id="staff-main" tabIndex={-1} ref={mainRef}>
      {connection !== "connected" ? <section className="staff-auth-card"><h1>{connection === "checking" ? "Connecting to the local server…" : connection === "missing-bridge" ? "Open the Cedar Staff desktop app" : "Local staff server unavailable"}</h1><p className="staff-intro">{connection === "missing-bridge" ? "This interface needs its protected desktop bridge. Opening it in a regular browser does not provide staff access." : "No cached or offline sign-in is available. The local server, database and network must be available; external internet is not needed for this local development setup."}</p>{api && connection !== "checking" && <button className="staff-button staff-button-primary" type="button" onClick={() => { setError(""); setConnection("checking"); void checkAuthority(); }}>Try again</button>}</section> : <>
        {error && <p className="staff-global-error" role="alert">{error}</p>}
        {step === "workspace" && user && workspace ? <Workspace user={user} workspace={workspace} timing={timing} busy={busy} onContinue={(event) => reportActivity(event.nativeEvent)} /> : <section className={`staff-auth-card ${step === "setup" ? "staff-auth-card-wide" : ""}`}>
          {step === "sign-in" && <SignInForm busy={busy} setupAvailable={setupAvailable} onSetup={() => { setError(""); setStep("setup"); }} onSubmit={(credentials) => authenticate(() => api.signIn(credentials))} />}
          {step === "setup" && <SetupForm busy={busy} onCancel={returnToSignIn} onSubmit={(payload) => authenticate(() => api.claimSetup(payload))} />}
          {(step === "enroll" || step === "mfa") && <MfaPanel enrollment={step === "enroll"} api={api} busy={busy} onError={handleError} onCancel={returnToSignIn} onComplete={(payload) => authenticate(() => api.completeMfa(payload))} onBackup={(payload) => authenticate(() => api.useBackupCode(payload))} />}
          {step === "backup-codes" && <BackupCodesPanel codes={backupCodes} busy={busy} onCancel={returnToSignIn} onAcknowledge={() => perform(async (isCurrent) => { const result = await api.acknowledgeBackupCodes(); if (!isCurrent()) return; setBackupCodes([]); await openWorkspace(result); })} />}
        </section>}
      </>}
    </main>
    <footer className="staff-footer">Separate local staff foundation. No real employees, patients, appointments, or laboratory records are included.</footer>
  </div>;
}
