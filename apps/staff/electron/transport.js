export function validateAuthorityUrl(value, demoMode) {
  const url = new URL(value);
  if (
    url.hostname !== "127.0.0.1" ||
    !["4100", "4101"].includes(url.port) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "Only the isolated same-computer staff authority is supported.",
    );
  }
  if (url.protocol !== "https:" && !(demoMode && url.protocol === "http:"))
    throw new Error("HTTP requires explicit loopback demo mode.");
  return url.origin;
}

export function sanitizedResult(result) {
  const { token, challenge, ...publicResult } = result;
  return publicResult;
}

export function createBroker({ url, demoMode, request = fetch }) {
  const origin = validateAuthorityUrl(url, demoMode);
  let token;
  let challenge;
  let verificationChallenge;
  let contactChallenge;
  let contactGeneration = 0;
  let passwordChallenge;
  let passwordGeneration = 0;
  let recoveryChallenge;
  let recoveryCancellation;
  let recoveryGeneration = 0;
  let epoch = 0;
  async function call(
    path,
    body,
    authenticated = false,
    explicitToken = token,
    verification = false,
    currentOperation = () => true,
  ) {
    const requestedEpoch = epoch;
    if (authenticated && !explicitToken)
      throw Object.assign(new Error("Please sign in again."), {
        code: "AUTH_REQUIRED",
      });
    let response;
    try {
      response = await request(`${origin}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(authenticated
            ? { Authorization: `Bearer ${explicitToken}` }
            : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal: AbortSignal.timeout(
          path.startsWith("/password/change/") || path === "/recovery/complete"
            ? 5 * 60000
            : path.startsWith("/contacts/")
              ? 20000
              : 5000,
        ),
      });
    } catch {
      throw Object.assign(
        new Error(
          "The local staff server is unavailable. No offline sign-in is permitted.",
        ),
        { code: "AUTHORITY_UNAVAILABLE" },
      );
    }
    const data = await response.json().catch(() => null);
    if (
      (requestedEpoch !== epoch || !currentOperation()) &&
      (authenticated || data?.token || data?.challenge)
    ) {
      if (data?.token) {
        await request(`${origin}/auth/logout`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${data.token}`,
          },
          body: "{}",
          redirect: "error",
          signal: AbortSignal.timeout(3000),
        }).catch(() => {});
      }
      throw Object.assign(
        new Error(
          "This sign-in action is no longer current. Please try again.",
        ),
        { code: "ACTION_SUPERSEDED" },
      );
    }
    if (!response.ok || !data) {
      const error = data?.error;
      if (
        explicitToken === token &&
        [
          "auth_required",
          "session_expired",
          "session_revoked",
          "unauthorized",
          "authentication_failed",
        ].includes(String(error?.code).toLowerCase())
      )
        token = undefined;
      throw Object.assign(
        new Error(
          error?.message ||
            "The local staff authority could not complete this action.",
        ),
        { code: error?.code || "AUTHORITY_UNAVAILABLE" },
      );
    }
    if (data.token) token = data.token;
    if (data.challenge) {
      if (verification === "recovery") recoveryChallenge = data.challenge;
      else if (verification === "password") passwordChallenge = data.challenge;
      else if (verification === "contact") contactChallenge = data.challenge;
      else if (verification) verificationChallenge = data.challenge;
      else challenge = data.challenge;
    }
    return sanitizedResult(data);
  }
  const needChallenge = () => {
    if (!challenge)
      throw Object.assign(
        new Error("Restart sign-in to receive a new verification challenge."),
        { code: "CHALLENGE_REQUIRED" },
      );
    return challenge;
  };
  const needVerification = () => {
    if (!verificationChallenge)
      throw Object.assign(new Error("Start password verification again."), {
        code: "VERIFICATION_REQUIRED",
      });
    return verificationChallenge;
  };

  const target = (payload) => {
    if (
      typeof payload?.accountId !== "string" ||
      !/^[A-Za-z0-9:_-]{1,120}$/.test(payload.accountId)
    )
      throw Object.assign(new Error("Choose a valid staff account."), {
        code: "INVALID_ACTION",
      });
    return encodeURIComponent(payload.accountId);
  };
  const withoutId = ({ accountId, ...body }) => body;
  async function recoveryCall(action, payload = {}, starting = false) {
    if (starting) {
      if (recoveryCancellation)
        throw Object.assign(
          new Error(
            "Confirm cancellation of the previous recovery request first.",
          ),
          { code: "recovery_cancellation_pending" },
        );
      recoveryGeneration++;
      recoveryChallenge = undefined;
    }
    const generation = recoveryGeneration;
    if (!starting && !recoveryChallenge)
      throw Object.assign(new Error("Start recovery again."), {
        code: "recovery_expired",
      });
    const result = await call(
      `/recovery/${action}`,
      { ...payload, ...(starting ? {} : { challenge: recoveryChallenge }) },
      false,
      undefined,
      "recovery",
      () => generation === recoveryGeneration,
    );
    if (generation !== recoveryGeneration)
      throw Object.assign(new Error("Recovery is no longer current."), {
        code: "ACTION_SUPERSEDED",
      });
    if (result.completed) {
      recoveryGeneration++;
      recoveryChallenge = undefined;
    }
    return result;
  }
  return {
    requestRecovery: (payload) => recoveryCall("request", payload, true),
    verifyRecovery: (payload) => recoveryCall("verify", payload),
    resendRecovery: () => recoveryCall("resend"),
    verifyRecoveryFactor: (payload) => recoveryCall("factor", payload),
    redeemRecovery: (payload) => recoveryCall("redeem", payload, true),
    proveRecoveryPassword: (payload) =>
      recoveryCall("provePassword", payload, true),
    replaceRecoveryMfa: () => recoveryCall("replace", { confirmed: true }),
    saveRecoveryPassword: (payload) => recoveryCall("complete", payload),
    recoveryEnrollment: () => recoveryCall("enrollment"),
    confirmRecoveryMfa: (payload) => recoveryCall("enroll", payload),
    recoveryBackups: () => recoveryCall("backups"),
    acknowledgeRecoveryBackups: () =>
      recoveryCall("acknowledge", { confirmed: true }),
    recoveryStatus: () => recoveryCall("status"),
    cancelRecovery: async () => {
      const previous = recoveryCancellation ?? recoveryChallenge;
      recoveryGeneration++;
      recoveryChallenge = undefined;
      recoveryCancellation = previous;
      if (previous) await call("/recovery/cancel", { challenge: previous });
      if (recoveryCancellation === previous) recoveryCancellation = undefined;
      return { cancelled: true };
    },
    assistStaffRecovery: (payload) =>
      call(`/staff/${target(payload)}/recovery`, withoutId(payload), true),
    revokeStaffRecovery: (payload) =>
      call(
        `/staff/${target(payload)}/recovery/revoke`,
        withoutId(payload),
        true,
      ),
    status: () => call("/health"),
    setupStatus: () => call("/setup/status"),
    claimSetup: (payload) => call("/setup/claim", payload),
    signIn: async (payload) => {
      recoveryCancellation = undefined;
      recoveryGeneration++;
      recoveryChallenge = undefined;
      epoch += 1;
      passwordGeneration += 1;
      passwordChallenge = undefined;
      token = undefined;
      challenge = undefined;
      verificationChallenge = undefined;
      contactChallenge = undefined;
      return call("/auth/login", payload);
    },
    activateAssignedAccount: async (payload) => {
      epoch += 1;
      passwordGeneration += 1;
      passwordChallenge = undefined;
      token = undefined;
      challenge = undefined;
      verificationChallenge = undefined;
      contactChallenge = undefined;
      return call("/account/setup", payload);
    },
    enrollment: () => call("/mfa/enroll", { challenge: needChallenge() }),
    completeMfa: (payload) =>
      call("/mfa/complete", { challenge: needChallenge(), code: payload.code }),
    useBackupCode: (payload) =>
      call("/mfa/backup", { challenge: needChallenge(), code: payload.code }),
    acknowledgeBackupCodes: async () => {
      await call("/mfa/acknowledge", {}, true);
      return call("/auth/session", undefined, true);
    },
    sessionStatus: () => call("/auth/session", undefined, true),
    activity: () => call("/auth/activity", { kind: "interaction" }, true),
    workspace: () => call("/workspace", undefined, true),
    startPasswordChange: async (payload) => {
      const generation = ++passwordGeneration;
      return call(
        "/password/change/start",
        payload,
        true,
        token,
        "password",
        () => generation === passwordGeneration,
      );
    },
    completePasswordIdentity: (payload) => {
      if (!passwordChallenge)
        throw Object.assign(new Error("Start the password check again."), {
          code: "password_change_expired",
        });
      const generation = passwordGeneration;
      return call(
        "/password/change/identity",
        { ...payload, challenge: passwordChallenge },
        true,
        token,
        "password",
        () => generation === passwordGeneration,
      );
    },
    savePasswordChange: async (payload) => {
      if (!passwordChallenge)
        throw Object.assign(new Error("Start the password check again."), {
          code: "password_change_expired",
        });
      const generation = passwordGeneration;
      const result = await call(
        "/password/change/complete",
        { ...payload, challenge: passwordChallenge },
        true,
        token,
        "password",
        () => generation === passwordGeneration,
      );
      if (result.passwordChanged === true) {
        epoch += 1;
        passwordGeneration += 1;
        token =
          challenge =
          verificationChallenge =
          contactChallenge =
          passwordChallenge =
            undefined;
      }
      return result;
    },
    cancelPasswordChange: async () => {
      passwordGeneration += 1;
      passwordChallenge = undefined;
      return call("/password/change/cancel", {}, true);
    },
    staffDirectory: () => call("/staff", undefined, true),
    operationalState: () => call("/operations", undefined, true),
    saveOperationalRecord: (payload) => call("/operations/save", payload, true),
    assignOperationalScopes: (payload) =>
      call("/operations/grants", payload, true),
    publishOperationalDrafts: (payload) =>
      call("/operations/publish", payload, true),
    previewOperationalPublication: (payload) =>
      call("/operations/preview", payload, true),
    ownProfile: () => call("/profiles/me", undefined, true),
    staffProfile: (payload) =>
      call(`/staff/${target(payload)}/profile`, undefined, true),
    createStaff: (payload) => call("/staff", payload, true),
    updateStaffProfile: (payload) =>
      call(`/staff/${target(payload)}/profile`, withoutId(payload), true),
    updateOwnContact: (payload) => call("/profiles/me/contact", payload, true),
    contactStatus: () => call("/contacts/status", undefined, true),
    startContactIdentity: async (payload) => {
      const previousChallenge = contactChallenge,
        previousEpoch = epoch,
        previousToken = token,
        generation = ++contactGeneration;
      contactChallenge = undefined;
      try {
        return await call(
          "/contacts/identity/start",
          payload,
          true,
          token,
          "contact",
        );
      } catch (error) {
        if (
          ["contact_email_already_verified", "contact_email_in_use"].includes(
            error.code,
          ) &&
          generation === contactGeneration &&
          previousEpoch === epoch &&
          previousToken === token
        )
          contactChallenge = previousChallenge;
        throw error;
      }
    },
    completeContactIdentity: async (payload) => {
      if (!contactChallenge)
        throw Object.assign(
          new Error("Start the contact password check again."),
          { code: "contact_identity_required" },
        );
      const result = await call(
        "/contacts/identity/complete",
        { ...payload, challenge: contactChallenge },
        true,
        token,
        "contact",
      );
      contactChallenge = undefined;
      return result;
    },
    resendContactCode: (payload) => call("/contacts/resend", payload, true),
    cancelContactChange: async (payload) => {
      contactGeneration += 1;
      contactChallenge = undefined;
      return call("/contacts/cancel", payload, true);
    },
    completeContactChange: (payload) =>
      call("/contacts/complete", payload, true),
    changeStaffRoles: (payload) =>
      call(`/staff/${target(payload)}/roles`, withoutId(payload), true),
    changeStaffStatus: (payload) =>
      call(`/staff/${target(payload)}/status`, withoutId(payload), true),
    replaceStaffSetupCode: (payload) =>
      call(`/staff/${target(payload)}/setup-code`, withoutId(payload), true),
    releaseStaffEmail: (payload) =>
      call(`/staff/${target(payload)}/email/release`, withoutId(payload), true),
    startVerification: async (payload) => {
      verificationChallenge = undefined;
      return call("/auth/reverify/start", payload, true, token, true);
    },
    completeVerification: async (payload) => {
      const result = await call(
        "/auth/reverify/complete",
        {
          challenge: needVerification(),
          code: payload.code,
          method: payload.method,
        },
        true,
        token,
        true,
      );
      verificationChallenge = undefined;
      return result;
    },
    signOut: async () => {
      recoveryCancellation = undefined;
      recoveryGeneration++;
      recoveryChallenge = undefined;
      epoch += 1;
      passwordGeneration += 1;
      passwordChallenge = undefined;
      const previous = token;
      token = undefined;
      challenge = undefined;
      verificationChallenge = undefined;
      contactChallenge = undefined;
      if (previous) await call("/auth/logout", {}, true, previous);
      return { signedOut: true };
    },
    forget: () => {
      recoveryCancellation = undefined;
      recoveryGeneration++;
      recoveryChallenge = undefined;
      epoch += 1;
      token = undefined;
      challenge = undefined;
      verificationChallenge = undefined;
      contactChallenge = undefined;
      passwordChallenge = undefined;
      passwordGeneration += 1;
    },
  };
}
