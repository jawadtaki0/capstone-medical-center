import express from "express";
import { integrationAuthorized } from "../../../shared/website-request-security.mjs";
import {
  RequestError,
  exact,
} from "../../../shared/website-request-contract.mjs";
export function websiteRequestRouter({
  service,
  credential,
  trustedProxy = false,
  sourceReader = null,
}) {
  const router = express.Router();
  router.use((_q, r, n) => {
    r.set({
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex, nofollow",
    });
    n();
  });
  let active = 0;
  const route = (action) => async (q, r) => {
    if (active >= 16)
      return r.status(503).json({
        error: {
          code: "request_busy",
          message:
            "The request service is busy. Please retry; no booking is confirmed.",
        },
      });
    active++;
    try {
      r.json(await action(q));
    } catch (e) {
      const status = e instanceof RequestError ? e.status : 503;
      if (status === 429) r.set("Retry-After", "60");
      r.status(status).json({
        error: {
          code: e instanceof RequestError ? e.code : "request_unavailable",
          message:
            e instanceof RequestError
              ? e.message
              : "Requests are temporarily unavailable. No booking is confirmed.",
        },
      });
    } finally {
      active--;
    }
  };
  const json = express.json({ limit: "16kb", strict: true, inflate: false }),
    source =
      sourceReader ?? ((q) => (trustedProxy ? q.ip : q.socket.remoteAddress));
  router.get(
    "/professionals",
    route(
      (q) => (exact(q.query, ["date"]), service.professionals(q.query.date)),
    ),
  );
  router.get(
    "/upcoming",
    route((q) => {
      exact(
        q.query,
        ["professionalId", "fromDate", "after"],
        ["professionalId", "fromDate"],
      );
      return service.upcoming(q.query);
    }),
  );
  router.get(
    "/sessions",
    route((q) => (exact(q.query, ["date"]), service.sessions(q.query.date))),
  );
  router.post(
    "/submit",
    json,
    route((q) => service.submit(q.body, source(q))),
  );
  router.post(
    "/track",
    json,
    route(
      (q) => (exact(q.body, ["token"]), service.track(q.body.token, source(q))),
    ),
  );
  router.use("/integration", (q, r, n) => {
    if (
      q.get("Origin") ||
      !integrationAuthorized(q.get("Authorization"), credential)
    )
      return r.status(401).json({
        error: {
          code: "request_authentication",
          message: "Request integration authentication required.",
        },
      });
    n();
  });
  router.post(
    "/integration/pull",
    json,
    route((q) => (exact(q.body, ["cursor"]), service.pull(q.body.cursor))),
  );
  router.post(
    "/integration/event",
    json,
    route((q) => service.accept(q.body)),
  );
  router.post(
    "/integration/availability",
    json,
    route((q) => service.acceptAvailability(q.body)),
  );
  router.post(
    "/integration/rotate",
    json,
    route((q) => service.rotate(q.body)),
  );
  router.use((e, _q, r, _n) =>
    r.status(e.type === "entity.too.large" ? 413 : 400).json({
      error: {
        code: "request_input",
        message: "Send one valid request within the permitted size.",
      },
    }),
  );
  return router;
}
