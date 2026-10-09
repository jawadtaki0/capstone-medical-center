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
  let epoch = 0;
  async function call(
    path,
    body,
    authenticated = false,
    explicitToken = token,
    verification = false,
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
          path.startsWith("/contacts/") ? 20000 : 5000,
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
      requestedEpoch !== epoch &&
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
      if (verification === "contact") contactChallenge = data.challenge;
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
  return {
    status: () => call("/health"),
    setupStatus: () => call("/setup/status"),
    claimSetup: (payload) => call("/setup/claim", payload),
    signIn: async (payload) => {
      epoch += 1;
      token = undefined;
      challenge = undefined;
      verificationChallenge = undefined;
      contactChallenge = undefined;
      return call("/auth/login", payload);
    },
    activateAssignedAccount: async (payload) => {
      epoch += 1;
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
    staffDirectory: () => call("/staff", undefined, true),
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
      epoch += 1;
      const previous = token;
      token = undefined;
      challenge = undefined;
      verificationChallenge = undefined;
      contactChallenge = undefined;
      if (previous) await call("/auth/logout", {}, true, previous);
      return { signedOut: true };
    },
    forget: () => {
      epoch += 1;
      token = undefined;
      challenge = undefined;
      verificationChallenge = undefined;
      contactChallenge = undefined;
    },
  };
}
