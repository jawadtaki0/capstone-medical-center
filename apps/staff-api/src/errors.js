export class StaffError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "StaffError";
    this.code = code;
    this.status = status;
  }
}

export const denied = () => new StaffError("authentication_failed", "Sign-in could not be completed. Check your details and try again.", 401);
export const unavailable = () => new StaffError("authority_unavailable", "The local staff server is unavailable. No access has been granted.", 503);
export const limited = () => new StaffError("try_later", "Too many attempts. Please wait 15 minutes before trying again.", 429);

export function publicError(error) {
  const safe = error instanceof StaffError ? error : unavailable();
  return { status: safe.status, body: { error: { code: safe.code, message: safe.message } } };
}
