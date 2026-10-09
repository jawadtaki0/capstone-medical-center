export const ACTIVITY_INTERVAL_MS = 30_000;
const activityTypes = new Set([
  "click",
  "pointerdown",
  "touchstart",
  "keydown",
  "input",
  "wheel",
]);

export function isForegroundActivity({ type, isTrusted, visible, focused }) {
  // Wheel, touch and keyboard input count deliberate scrolling. The scroll event
  // alone also fires for programmatic movement, so it cannot renew a session.
  return (
    isTrusted === true &&
    visible === true &&
    focused === true &&
    activityTypes.has(type)
  );
}

export function shouldReportActivity(event, lastReportedAt, now) {
  return (
    isForegroundActivity(event) && now - lastReportedAt >= ACTIVITY_INTERVAL_MS
  );
}

export function sessionTiming(session, now = Date.now()) {
  if (!session) return { expired: true, warning: false, secondsRemaining: 0 };
  const serverNow = Date.parse(session.serverNow);
  const observedAt = Number.isFinite(session.observedAt)
    ? session.observedAt
    : now;
  const serverTime = serverNow + Math.max(0, now - observedAt);
  const idle = Date.parse(session.idleExpiresAt) - serverTime;
  const absolute = Date.parse(session.absoluteExpiresAt) - serverTime;
  if (![serverNow, idle, absolute].every(Number.isFinite)) {
    return { expired: true, warning: false, secondsRemaining: 0 };
  }
  const remaining = Math.min(idle, absolute);
  return {
    expired: remaining <= 0,
    warning: remaining > 0 && idle <= 60_000,
    secondsRemaining: Math.max(0, Math.ceil(remaining / 1000)),
  };
}

export function observeSession(session, now = Date.now()) {
  return session ? { ...session, observedAt: now } : null;
}

// Enrollment/login challenges have one server deadline rather than session idle
// and absolute deadlines. Use the same fail-closed clock calculation for both.
export function observeChallenge(challenge, now = Date.now()) {
  return observeSession(
    {
      serverNow: challenge?.serverNow,
      idleExpiresAt: challenge?.expiresAt,
      absoluteExpiresAt: challenge?.expiresAt,
    },
    now,
  );
}
