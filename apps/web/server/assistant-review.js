import { assistantHandler } from "../api/public-assistant.js";
import {
  cedarToday,
  createAssistant,
  geminiAssistant,
} from "./public-assistant.js";
import { relativeDay, scheduleSpecialty } from "./public-assistant-routing.js";

export function reviewSessionRows(date, today = cedarToday()) {
  const second = new Date(today + "T12:00:00Z");
  second.setUTCDate(second.getUTCDate() + 1);
  if (![today, second.toISOString().slice(0, 10)].includes(date)) return [];
  return [
    {
      date,
      professionalName: "Dr. Rowan Example",
      kind: "doctor",
      specialty: "Cardiology",
      professionalId: "review-rowan",
      sourceSessionId: "review-am",
      startTime: "10:00",
      endTime: "11:00",
      appointmentRequired: true,
    },
    {
      date,
      professionalName: "Dr. Rowan Example",
      kind: "doctor",
      specialty: "Cardiology",
      professionalId: "review-rowan",
      sourceSessionId: "review-pm",
      startTime: "15:00",
      endTime: "16:00",
      appointmentRequired: true,
    },
  ];
}

async function reviewIntent({ messages, today, sessionSearch, filters }) {
  await new Promise((resolve) => setTimeout(resolve, 550));
  const clean = (value) => value.toLowerCase().replace(/[\u064b-\u065f]/g, "");
  const text = clean(messages.at(-1));
  const history = clean(messages.join(" "));
  if (/fixture failure|عطل تجريبي/.test(text))
    throw Error("Fictional model failure");
  if (/price|cost|سعر/.test(text)) return { kind: "reception" };
  const labPatterns = {
    cbc: /cbc|full blood count|blood cell count|تعداد الدم/,
    esr: /esr|sedimentation|ترسيب/,
  };
  const tests = Object.entries(labPatterns)
    .filter(([, pattern]) => pattern.test(history))
    .map(([id]) => id);
  if (
    tests.length &&
    (/compare|different|sample|measure|قارن|فرق|عين|يقيس/.test(text) ||
      Object.values(labPatterns).some((pattern) => pattern.test(text)))
  )
    return {
      kind: "labs",
      tests,
      compare: /compare|different|قارن|فرق/.test(history),
    };
  if (sessionSearch) {
    const day =
      text.match(/\d{4}-\d{2}-\d{2}/)?.[0] || relativeDay(text, today);
    return {
      kind: "sessions",
      ...(day ? { from: day, through: day } : {}),
      specialty: /dermatology|جلدية/.test(text)
        ? "Dermatology"
        : scheduleSpecialty(text) || filters?.specialty || "Cardiology",
    };
  }
  return { kind: "reception" };
}

export function assistantReviewPlugin({ realModel = false } = {}) {
  return {
    name: "cedar-assistant-isolated-review",
    apply: "serve",
    configureServer(server) {
      const model = realModel
        ? geminiAssistant({
            key: process.env.GEMINI_API_KEY,
            model: process.env.CEDAR_GEMINI_MODEL,
          })
        : reviewIntent;
      const handler = assistantHandler(
        createAssistant({
          interpret: model,
          compose: realModel ? model : undefined,
          readSessions: reviewSessionRows,
        }),
      );
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url, "http://127.0.0.1");
        if (url.pathname === "/api/public-assistant") return handler(req, res);
        if (url.pathname.startsWith("/api/patient-account/")) {
          res.setHeader("Content-Type", "application/json");
          res.setHeader("Cache-Control", "no-store");
          if (url.pathname === "/api/patient-account/session") {
            return res.end(JSON.stringify({ account: null }));
          }
          res.statusCode = 405;
          return res.end(
            JSON.stringify({
              error: {
                message:
                  "Account actions are disabled in this isolated preview.",
              },
            }),
          );
        }
        if (!url.pathname.startsWith("/api/requests/")) return next();
        const date = url.searchParams.get("date");
        const action = url.pathname.split("/").at(-1);
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Cache-Control", "no-store");
        if (req.method !== "GET") {
          res.statusCode = 405;
          return res.end(
            JSON.stringify({
              error: {
                message: "This isolated preview does not accept submissions.",
              },
            }),
          );
        }
        if (action === "sessions")
          return res.end(JSON.stringify(reviewSessionRows(date)));
        if (action === "professionals")
          return res.end(
            JSON.stringify([
              {
                id: "review-rowan",
                name: "Dr. Rowan Example",
                kind: "doctor",
                specialty: "Cardiology",
              },
            ]),
          );
        if (action === "upcoming") {
          const fromDate = url.searchParams.get("fromDate");
          return res.end(
            JSON.stringify({
              sessions: reviewSessionRows(fromDate),
              fromDate,
              throughDate: fromDate,
              nextDate: null,
            }),
          );
        }
        res.statusCode = 404;
        return res.end("{}");
      });
    },
  };
}
