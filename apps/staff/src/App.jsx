import { useCallback, useEffect, useRef, useState } from "react";
import {
  AssignedSetupForm,
  SignInForm,
  SetupForm,
} from "./components/AuthForms.jsx";
import { BackupCodesPanel, MfaPanel } from "./components/MfaPanel.jsx";
import Workspace from "./components/Workspace.jsx";
import ManagerVerification from "./components/ManagerVerification.jsx";
import {
  observeChallenge,
  observeSession,
  sessionTiming,
  shouldReportActivity,
} from "./lib/activity.js";
import { desktopApi } from "./lib/desktopApi.js";

export default function App({ api = desktopApi }) {
  const [connection, setConnection] = useState(
    api ? "checking" : "missing-bridge",
  );
  const [setupAvailable, setSetupAvailable] = useState(false);
  const [step, setStep] = useState("sign-in");
  const [busy, setBusy] = useState(false);
  const [managementBusy, setManagementBusy] = useState(false);
  const [error, setError] = useState("");
  const [user, setUser] = useState(null);
  const [session, setSession] = useState(null);
  const [workspace, setWorkspace] = useState(null);
  const [backupCodes, setBackupCodes] = useState([]);
  const [now, setNow] = useState(Date.now);
  const [verification, setVerification] = useState(false);
  const verificationPending = useRef(null);
  const stepRef = useRef(step);
  const generation = useRef(0);
  const authorizationDeadline = useRef(null);
  const mainRef = useRef(null);
  const authorityPending = useRef(false);
  const activityPending = useRef(false);
  const lastActivity = useRef(-Infinity);
  stepRef.current = step;

  const forgetAccess = useCallback(() => {
    verificationPending.current?.reject(
      Object.assign(new Error("Sign in again to continue."), {
        code: "session_revoked",
      }),
    );
    verificationPending.current = null;
    setVerification(false);
    generation.current += 1;
    authorizationDeadline.current = null;
    setUser(null);
    setSession(null);
    setWorkspace(null);
    setBackupCodes([]);
    stepRef.current = "sign-in";
    setStep("sign-in");
    setBusy(false);
    setManagementBusy(false);
    lastActivity.current = -Infinity;
  }, []);

  const expireAccess = useCallback(() => {
    forgetAccess();
    setError("Your session expired. Sign in again to continue.");
    // This removes main's access token, not stored factors or backup codes.
    void api?.signOut().catch(() => {});
  }, [api, forgetAccess]);

  const isAccessCurrent = useCallback(
    (expectedGeneration = generation.current) => {
      if (expectedGeneration !== generation.current) return false;
      if (
        authorizationDeadline.current &&
        sessionTiming(authorizationDeadline.current, Date.now()).expired
      ) {
        expireAccess();
        return false;
      }
      return true;
    },
    [expireAccess],
  );

  const handleError = useCallback(
    (failure, context = "action") => {
      const code = String(failure?.code ?? "").toLowerCase();
      const message =
        typeof failure?.message === "string"
          ? failure.message
          : "The action could not be completed. Please try again.";
      if (
        context === "connection" ||
        code.includes("unavailable") ||
        code.includes("network") ||
        failure?.status === 503
      ) {
        forgetAccess();
        setConnection("unavailable");
        setError(
          "The local staff authority is unavailable. Access is blocked until it is available again.",
        );
        // Main forgets its token even when the remote revocation cannot be sent.
        void api?.signOut().catch(() => {});
        return;
      }
      if (
        context === "session" ||
        [
          "session_expired",
          "session_revoked",
          "auth_required",
          "authentication_failed",
        ].includes(code)
      ) {
        forgetAccess();
        void api?.signOut().catch(() => {});
      }
      setError(message);
    },
    [api, forgetAccess],
  );

  // The server, not this dialog, decides whether actual factor proof is fresh.
  // After verification, retry the original fixed operation so permissions,
  // revisions and session validity are checked again at its transaction boundary.
  async function sensitiveAction(action) {
    try {
      return await action();
    } catch (failure) {
      if (String(failure.code).toLowerCase() !== "verification_required")
        throw failure;
      if (verificationPending.current)
        throw new Error("Finish the current verification first.");
      const current = generation.current;
      await new Promise((resolve, reject) => {
        verificationPending.current = { resolve, reject };
        setVerification(true);
      });
      if (current !== generation.current)
        throw Object.assign(new Error("Sign in again to continue."), {
          code: "session_revoked",
        });
      return action();
    }
  }

  function finishVerification(result) {
    if (!isAccessCurrent() || !updateSession(result)) return;
    const pending = verificationPending.current;
    verificationPending.current = null;
    setVerification(false);
    pending?.resolve();
  }
  function cancelVerification() {
    const pending = verificationPending.current;
    verificationPending.current = null;
    setVerification(false);
    pending?.reject(
      Object.assign(new Error("Verification cancelled. No change was made."), {
        code: "action_cancelled",
      }),
    );
  }

  const updateSession = useCallback(
    (result, observedAt = Date.now()) => {
      if (result?.session) {
        const observed = observeSession(result.session, observedAt);
        if (sessionTiming(observed, Date.now()).expired) {
          expireAccess();
          return false;
        }
        authorizationDeadline.current = observed;
        setSession(observed);
      }
      if (result?.user) setUser(result.user);
      return true;
    },
    [expireAccess],
  );

  const checkAuthority = useCallback(async () => {
    if (!api || authorityPending.current) return;
    const current = generation.current;
    if (!isAccessCurrent(current)) return;
    authorityPending.current = true;
    try {
      const health = await api.status();
      if (!isAccessCurrent(current)) return;
      if (health.status !== "ok" || health.database !== "connected") {
        const failure = new Error("The local staff authority is unavailable.");
        failure.code = "authority_unavailable";
        throw failure;
      }
      if (stepRef.current === "sign-in") {
        const setup = await api.setupStatus();
        if (!isAccessCurrent(current)) return;
        setSetupAvailable(setup.available === true);
      }
      setConnection("connected");
    } catch (failure) {
      if (current === generation.current) handleError(failure, "connection");
    } finally {
      authorityPending.current = false;
    }
  }, [api, handleError, isAccessCurrent]);

  useEffect(() => {
    void checkAuthority();
    const timer = setInterval(() => {
      void checkAuthority();
    }, 15_000);
    return () => clearInterval(timer);
  }, [checkAuthority]);

  useEffect(() => {
    const heading = mainRef.current?.querySelector("h1");
    if (heading) {
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    }
  }, [connection, step]);

  async function perform(action) {
    const current = generation.current;
    if (!isAccessCurrent(current)) return;
    setBusy(true);
    setError("");
    const isCurrent = () => isAccessCurrent(current);
    try {
      await action(isCurrent);
    } catch (failure) {
      if (isCurrent()) handleError(failure);
    } finally {
      if (isCurrent()) setBusy(false);
    }
  }

  function authenticate(action) {
    return perform(async (isCurrent) => {
      const startedAt = Date.now();
      const result = await action();
      if (isCurrent()) await acceptAuthentication(result, startedAt);
    });
  }

  async function openWorkspace(result, observedAt = Date.now()) {
    const current = generation.current;
    if (!isAccessCurrent(current)) return;
    const requestedAt = Date.now();
    const identity =
      result?.user && result?.session ? result : await api.sessionStatus();
    if (!isAccessCurrent(current)) return;
    if (!identity.user || !identity.session)
      throw new Error("Sign in again to verify your session.");
    if (
      !updateSession(identity, identity === result ? observedAt : requestedAt)
    )
      return;
    const authorizedWorkspace = await api.workspace();
    if (!isAccessCurrent(current)) return;
    setWorkspace(authorizedWorkspace);
    setBackupCodes([]);
    setStep("workspace");
    lastActivity.current = -Infinity;
  }

  async function acceptAuthentication(result, observedAt) {
    if (!result || typeof result !== "object")
      throw new Error(
        "The local server returned an incomplete sign-in response. Try again.",
      );
    if (result.kind === "enroll" || result.kind === "mfa") {
      const observed = observeChallenge(result, observedAt);
      if (sessionTiming(observed, Date.now()).expired) {
        expireAccess();
        return;
      }
      authorizationDeadline.current = observed;
      setSetupAvailable(false);
      setStep(result.kind);
    } else if (
      result.needsBackupAcknowledgement ||
      result.backupCodes?.length
    ) {
      if (!result.session || !updateSession(result, observedAt)) return;
      setBackupCodes(result.backupCodes ?? []);
      setStep("backup-codes");
    } else await openWorkspace(result, observedAt);
  }

  function returnToSignIn() {
    forgetAccess();
    setError("");
    void api.signOut().catch(() => {});
    void checkAuthority();
  }

  const reportActivity = useCallback(
    (event) => {
      const timestamp = Date.now();
      if (!isAccessCurrent()) return;
      const observation = {
        type: event.type,
        isTrusted: event.isTrusted,
        visible: !document.hidden,
        focused: document.hasFocus(),
      };
      if (
        stepRef.current !== "workspace" ||
        activityPending.current ||
        !shouldReportActivity(observation, lastActivity.current, timestamp)
      )
        return;
      lastActivity.current = timestamp;
      activityPending.current = true;
      const current = generation.current;
      api
        .activity()
        .then(async (result) =>
          result?.session ? result : api.sessionStatus(),
        )
        .then((result) => {
          if (isAccessCurrent(current) && stepRef.current === "workspace")
            updateSession(result, timestamp);
        })
        .catch((failure) => {
          if (current === generation.current) handleError(failure, "session");
        })
        .finally(() => {
          activityPending.current = false;
        });
    },
    [api, handleError, updateSession, isAccessCurrent],
  );

  useEffect(() => {
    if (step !== "workspace" || connection !== "connected") return;
    const types = ["pointerdown", "touchstart", "keydown", "input", "wheel"];
    types.forEach((type) =>
      document.addEventListener(type, reportActivity, {
        capture: true,
        passive: true,
      }),
    );
    return () => {
      types.forEach((type) =>
        document.removeEventListener(type, reportActivity, true),
      );
    };
  }, [step, connection, reportActivity]);

  useEffect(() => {
    if (
      !["workspace", "backup-codes"].includes(step) ||
      connection !== "connected"
    )
      return;
    let pending = false;
    const current = generation.current;
    const checkSession = () => {
      if (pending || !isAccessCurrent(current)) return;
      pending = true;
      const startedAt = Date.now();
      api
        .sessionStatus()
        .then((result) => {
          if (isAccessCurrent(current)) updateSession(result, startedAt);
        })
        .catch((failure) => {
          if (isAccessCurrent(current)) handleError(failure, "session");
        })
        .finally(() => {
          pending = false;
        });
    };
    const timer = setInterval(checkSession, 15_000);
    window.addEventListener("focus", checkSession);
    window.addEventListener("pageshow", checkSession);
    document.addEventListener("visibilitychange", checkSession);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", checkSession);
      window.removeEventListener("pageshow", checkSession);
      document.removeEventListener("visibilitychange", checkSession);
    };
  }, [step, connection, api, isAccessCurrent, updateSession, handleError]);

  // Timers can be delayed while suspended. Wake/input checks compare actual
  // deadlines before any private action; none of these checks reports activity.
  useEffect(() => {
    if (!["enroll", "mfa", "backup-codes", "workspace"].includes(step)) return;
    const current = generation.current;
    const checkDeadline = () => isAccessCurrent(current);
    const refreshClock = () => {
      if (checkDeadline()) setNow(Date.now());
    };
    refreshClock();
    const timer = setInterval(refreshClock, 1000);
    const events = ["pointerdown", "touchstart", "keydown", "input", "wheel"];
    events.forEach((type) =>
      document.addEventListener(type, checkDeadline, {
        capture: true,
        passive: true,
      }),
    );
    // Input capture checks must not redraw a controlled field before React's
    // own change handler reads it. Only timer/wake events refresh the warning.
    window.addEventListener("focus", refreshClock);
    window.addEventListener("pageshow", refreshClock);
    document.addEventListener("visibilitychange", refreshClock);
    return () => {
      clearInterval(timer);
      events.forEach((type) =>
        document.removeEventListener(type, checkDeadline, true),
      );
      window.removeEventListener("focus", refreshClock);
      window.removeEventListener("pageshow", refreshClock);
      document.removeEventListener("visibilitychange", refreshClock);
    };
  }, [step, isAccessCurrent]);

  const timing = sessionTiming(session, now);

  return (
    <div className="staff-app">
      <a className="staff-skip-link" href="#staff-main">
        Skip to content
      </a>
      <header className="staff-header">
        <div className="staff-brand">
          <span aria-hidden="true" className="staff-brand-mark">
            +
          </span>
          <span>
            Cedar Staff<small>STAFF FOUNDATION · SYNTHETIC DEVELOPMENT</small>
          </span>
        </div>
        <div className="staff-header-actions">
          <span className="staff-connection" role="status">
            {connection === "connected"
              ? "Local server connected"
              : connection === "checking"
                ? "Checking local server…"
                : "Access unavailable"}
          </span>
          {step === "workspace" && (
            <>
              {connection === "connected" && user?.username && (
                <span className="staff-signed-in">
                  <small>Signed in as</small>
                  <span>{user.username}</span>
                </span>
              )}
              <button
                className="staff-button"
                type="button"
                disabled={busy || managementBusy || verification}
                onClick={() =>
                  perform(async () => {
                    forgetAccess();
                    await api.signOut();
                  })
                }
              >
                Sign out
              </button>
            </>
          )}
        </div>
      </header>
      <main id="staff-main" tabIndex={-1} ref={mainRef}>
        {connection !== "connected" ? (
          <section className="staff-auth-card">
            <h1>
              {connection === "checking"
                ? "Connecting to the local server…"
                : connection === "missing-bridge"
                  ? "Open the Cedar Staff desktop app"
                  : "Local staff server unavailable"}
            </h1>
            <p className="staff-intro">
              {connection === "missing-bridge"
                ? "This interface needs its protected desktop bridge. Opening it in a regular browser does not provide staff access."
                : "No cached or offline sign-in is available. The local server, database and network must be available; external internet is not needed for this local development setup."}
            </p>
            {api && connection !== "checking" && (
              <button
                className="staff-button staff-button-primary"
                type="button"
                onClick={() => {
                  setError("");
                  setConnection("checking");
                  void checkAuthority();
                }}
              >
                Try again
              </button>
            )}
          </section>
        ) : (
          <>
            {error && (
              <p className="staff-global-error" role="alert">
                {error}
              </p>
            )}
            {step === "workspace" && user && workspace ? (
              <Workspace
                api={api}
                onError={handleError}
                onSensitiveAction={sensitiveAction}
                user={user}
                workspace={workspace}
                timing={timing}
                busy={busy || managementBusy || verification}
                onPendingChange={setManagementBusy}
                onContinue={(event) => reportActivity(event.nativeEvent)}
              />
            ) : (
              <section
                className={`staff-auth-card ${step === "setup" ? "staff-auth-card-wide" : ""}`}
              >
                {step === "sign-in" && (
                  <SignInForm
                    busy={busy}
                    setupAvailable={setupAvailable}
                    onAssignedSetup={() => {
                      setError("");
                      setStep("assigned-setup");
                    }}
                    onSetup={() => {
                      setError("");
                      setStep("setup");
                    }}
                    onSubmit={(credentials) =>
                      authenticate(() => api.signIn(credentials))
                    }
                  />
                )}
                {step === "setup" && (
                  <SetupForm
                    busy={busy}
                    onCancel={returnToSignIn}
                    onSubmit={(payload) =>
                      authenticate(() => api.claimSetup(payload))
                    }
                  />
                )}
                {step === "assigned-setup" && (
                  <AssignedSetupForm
                    busy={busy}
                    onCancel={returnToSignIn}
                    onSubmit={(payload) =>
                      authenticate(() => api.activateAssignedAccount(payload))
                    }
                  />
                )}
                {(step === "enroll" || step === "mfa") && (
                  <MfaPanel
                    enrollment={step === "enroll"}
                    api={api}
                    busy={busy}
                    accessGeneration={generation.current}
                    isAccessCurrent={isAccessCurrent}
                    onError={handleError}
                    onCancel={returnToSignIn}
                    onComplete={(payload) =>
                      authenticate(() => api.completeMfa(payload))
                    }
                    onBackup={(payload) =>
                      authenticate(() => api.useBackupCode(payload))
                    }
                  />
                )}
                {step === "backup-codes" && (
                  <BackupCodesPanel
                    codes={backupCodes}
                    busy={busy}
                    onCancel={returnToSignIn}
                    onAcknowledge={() =>
                      perform(async (isCurrent) => {
                        const startedAt = Date.now();
                        const result = await api.acknowledgeBackupCodes();
                        if (!isCurrent()) return;
                        setBackupCodes([]);
                        await openWorkspace(result, startedAt);
                      })
                    }
                  />
                )}
              </section>
            )}
          </>
        )}
        {verification && step === "workspace" && (
          <ManagerVerification
            api={api}
            onComplete={finishVerification}
            onCancel={cancelVerification}
            onError={handleError}
          />
        )}
      </main>
      <footer className="staff-footer">
        Separate local staff foundation. No real employees, patients,
        appointments, or laboratory records are included.
      </footer>
    </div>
  );
}
