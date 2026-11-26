import { createLocalIntentMatcher } from "../server/public-assistant-local-match.js";
import {
  createPublicAssistant,
  publishedHours,
  publishedSessions,
} from "../server/public-assistant.js";
import { randomUUID } from "node:crypto";
import { containsPrivateAccountText } from "../server/public-assistant-account.js";
import {
  validCurrentMessage,
  validPublicContext,
} from "../server/public-assistant-context.js";

const publicOrigin =
  process.env.CEDAR_ASSISTANT_PUBLIC_ORIGIN ??
  "https://cedar-cmc-api.onrender.com";
const assistant = createPublicAssistant({
  demo: true,
  matchIntent: createLocalIntentMatcher(),
  readSessions: publishedSessions(publicOrigin),
  readHours: publishedHours(publicOrigin),
});

export function assistantHandler(answer) {
  let calls = 0;
  let reset = 0;
  return async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    const send = (status, body) => {
      res.statusCode = status;
      res.end(JSON.stringify(body));
    };
    if (req.method !== "POST") return send(405, {});
    if (!/^application\/json(?:;|$)/i.test(req.headers["content-type"] ?? ""))
      return send(415, {});
    if (Date.now() >= reset) {
      calls = 0;
      reset = Date.now() + 60_000;
    }
    if (++calls > 30) return send(429, {});
    if (req.headers.cookie || req.headers.authorization) return send(400, {});
    try {
      let body = req.body;
      if (body === undefined) {
        let raw = "";
        for await (const chunk of req) {
          raw += chunk;
          if (Buffer.byteLength(raw) > 12_000) return send(413, {});
        }
        body = JSON.parse(raw);
      } else if (Buffer.byteLength(JSON.stringify(body)) > 12_000)
        return send(413, {});
      if (typeof body === "string") body = JSON.parse(body);
      if (!body || typeof body !== "object" || Array.isArray(body))
        return send(400, {});
      if (
        Object.keys(body).length !== 3 ||
        !["en", "ar"].includes(body.language) ||
        !validCurrentMessage(body.message) ||
        !validPublicContext(body.context) ||
        containsPrivateAccountText(body.message)
      )
        return send(400, {});
      const message = body.message;
      const input =
        typeof message === "string" ? { messages: [message] } : message;
      const started = Date.now();
      const provider = [];
      let routeReason;
      const result = await answer(
        { ...input, language: body.language, publicTurnContext: body.context },
        {
          observe: (event) => provider.push(event),
          trace: (reason) => {
            routeReason = reason;
          },
        },
      );
      const fallback = Boolean(
        result.fallback ||
          result.kind === "reception" ||
          result.kind === "unavailable",
      );
      const fallbackReason = fallback
        ? (provider.find(({ outcome }) =>
            [
              "rejected",
              "unsupported",
              "http",
              "timeout",
              "deadline",
              "network",
              "malformed",
              "configuration",
            ].includes(outcome),
          )?.outcome ?? routeReason)
        : undefined;
      console.info(
        JSON.stringify({
          route: result.kind,
          latency: Date.now() - started,
          routeReason,
          fallback,
          fallbackReason,
          provider,
          requestId: randomUUID(),
        }),
      );
      return send(200, result);
    } catch {
      return send(400, {});
    }
  };
}

export default assistantHandler(assistant);
