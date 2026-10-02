export function validateAuthorityUrl(value, demoMode) {
  const url = new URL(value);
  if (url.hostname !== '127.0.0.1' || !['4100', '4101'].includes(url.port) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Only the isolated same-computer staff authority is supported.');
  }
  if (url.protocol !== 'https:' && !(demoMode && url.protocol === 'http:')) throw new Error('HTTP requires explicit loopback demo mode.');
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
  let epoch = 0;
  async function call(path, body, authenticated = false, explicitToken = token) {
    const requestedEpoch = epoch;
    if (authenticated && !explicitToken) throw Object.assign(new Error('Please sign in again.'), { code: 'AUTH_REQUIRED' });
    let response;
    try {
      response = await request(`${origin}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(authenticated ? { Authorization: `Bearer ${explicitToken}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error', signal: AbortSignal.timeout(5000)
      });
    } catch { throw Object.assign(new Error('The local staff server is unavailable. No offline sign-in is permitted.'), { code: 'AUTHORITY_UNAVAILABLE' }); }
    const data = await response.json().catch(() => null);
    // Public health/setup polling is independent of a new sign-in. Only stale
    // credential-bearing or protected responses must be invalidated here.
    if (requestedEpoch !== epoch && (authenticated || data?.token || data?.challenge)) {
      if (data?.token) {
        await request(`${origin}/auth/logout`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.token}` }, body: '{}', redirect: 'error', signal: AbortSignal.timeout(3000) }).catch(() => {});
      }
      throw Object.assign(new Error('This sign-in action is no longer current. Please try again.'), { code: 'ACTION_SUPERSEDED' });
    }
    if (!response.ok || !data) {
      const error = data?.error;
      if (explicitToken === token && ['auth_required', 'session_expired', 'session_revoked', 'unauthorized', 'authentication_failed'].includes(String(error?.code).toLowerCase())) token = undefined;
      throw Object.assign(new Error(error?.message || 'The local staff authority could not complete this action.'), { code: error?.code || 'AUTHORITY_UNAVAILABLE' });
    }
    if (data.token) token = data.token;
    if (data.challenge) challenge = data.challenge;
    return sanitizedResult(data);
  }
  const needChallenge = () => { if (!challenge) throw Object.assign(new Error('Restart sign-in to receive a new verification challenge.'), { code: 'CHALLENGE_REQUIRED' }); return challenge; };
  return {
    status: () => call('/health'),
    setupStatus: () => call('/setup/status'),
    claimSetup: payload => call('/setup/claim', payload),
    signIn: async payload => { epoch += 1; token = undefined; challenge = undefined; return call('/auth/login', payload); },
    enrollment: () => call('/mfa/enroll', { challenge: needChallenge() }),
    completeMfa: payload => call('/mfa/complete', { challenge: needChallenge(), code: payload.code }),
    useBackupCode: payload => call('/mfa/backup', { challenge: needChallenge(), code: payload.code }),
    acknowledgeBackupCodes: async () => { await call('/mfa/acknowledge', {}, true); return call('/auth/session', undefined, true); },
    sessionStatus: () => call('/auth/session', undefined, true),
    activity: () => call('/auth/activity', { kind: 'interaction' }, true),
    workspace: () => call('/workspace', undefined, true),
    signOut: async () => { epoch += 1; const previous = token; token = undefined; challenge = undefined; if (previous) await call('/auth/logout', {}, true, previous); return { signedOut: true }; },
    forget: () => { epoch += 1; token = undefined; challenge = undefined; }
  };
}
