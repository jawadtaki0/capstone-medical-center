import express from "express";
import helmet from "helmet";
import { createAuthService } from "./auth.js";
import { StaffError, publicError, unavailable } from "./errors.js";

const loopback = (address) => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address);
function bearer(request) {
  const value = request.get("Authorization") ?? "";
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(value);
  if (!match) throw new StaffError("authentication_failed", "Sign in again to continue.", 401);
  return match[1];
}

export function createApp({ db, client, vault, clock = () => new Date(), demoMode = false } = {}) {
  const app = express();
  const auth = db && client && vault ? createAuthService({ db, client, vault, clock }) : null;
  app.disable("x-powered-by");
  app.set("trust proxy", false);
  app.use(helmet());
  app.use((request, response, next) => {
    response.set("Cache-Control", "no-store");
    if (demoMode) {
      if (!loopback(request.socket.remoteAddress) || !["localhost", "127.0.0.1", "[::1]"].includes(request.hostname)) {
        next(new StaffError("transport_denied", "This demonstration is restricted to this computer.", 403));
        return;
      }
    } else if (!request.secure) {
      next(new StaffError("transport_denied", "A trusted secure connection is required.", 403));
      return;
    }
    // The desktop's allowlisted main-process bridge uses explicit tokens and no
    // ambient cookies. Unrelated browser origins cannot call setup or sign-in.
    const origin = request.get("Origin");
    if (origin && origin !== "app://staff") {
      next(new StaffError("origin_denied", "This request is not from the trusted staff application.", 403));
      return;
    }
    if (!["GET", "HEAD"].includes(request.method) && !request.is("application/json")) {
      next(new StaffError("json_required", "Send an explicit JSON request.", 415));
      return;
    }
    next();
  });
  app.use(express.json({ limit: "16kb", strict: true }));
  const route = (handler) => async (request, response) => {
    if (!auth) throw unavailable();
    response.json(await handler(auth, request));
  };
  const source = (request) => request.socket.remoteAddress;
  app.get("/health", route((service) => service.health()));
  app.get("/setup/status", route((service) => service.setupStatus()));
  app.post("/setup/claim", route((service, request) => service.claimSetup(request.body, source(request))));
  app.post("/auth/login", route((service, request) => service.login(request.body, source(request))));
  app.post("/mfa/enroll", route((service, request) => service.enroll(request.body, source(request))));
  app.post("/mfa/complete", route((service, request) => service.completeMfa(request.body, source(request))));
  app.post("/mfa/backup", route((service, request) => service.useBackup(request.body, source(request))));
  app.post("/mfa/acknowledge", route((service, request) => service.acknowledge(bearer(request))));
  app.get("/auth/session", route((service, request) => service.readSession(bearer(request))));
  app.post("/auth/activity", route((service, request) => service.activity(bearer(request))));
  app.post("/auth/logout", route((service, request) => service.logout(bearer(request))));
  app.get("/workspace", route((service, request) => service.workspace(bearer(request))));
  app.use((_request, _response, next) => next(new StaffError("route_not_found", "This staff action is not available.", 404)));
  app.use((error, _request, response, _next) => {
    const normalized = error?.type === "entity.parse.failed"
      ? new StaffError("invalid_json", "Send a valid JSON object.")
      : error?.type === "entity.too.large" ? new StaffError("request_too_large", "This request is too large.", 413) : error;
    const safe = publicError(normalized);
    if (safe.status === 429) response.set("Retry-After", "900");
    response.status(safe.status).json(safe.body);
  });
  return app;
}
