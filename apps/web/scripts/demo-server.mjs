// Local demo of the website with Ask Cedar. Reads published data only: every
// other write is refused, so a demo can never submit a real request.
//   node scripts/demo-server.mjs               live published data
//   node scripts/demo-server.mjs <snapshot>    saved rows, works offline
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import react from "@vitejs/plugin-react";
import { build, preview } from "vite";
import assistant, { assistantHandler } from "../api/public-assistant.js";
import { createPublicAssistant } from "../server/public-assistant.js";
import { createLocalIntentMatcher } from "../server/public-assistant-local-match.js";

const origin = "https://cedar-cmc-api.onrender.com";

function savedData(snapshot) {
  const rows = Object.values(snapshot.schedule).flat();
  const professionals = [
    ...new Map(
      rows.map((row) => [
        row.professionalId,
        {
          id: row.professionalId,
          name: row.professionalName,
          specialty: row.specialty,
          kind: row.kind,
          avatarVariant: row.avatarVariant,
        },
      ]),
    ).values(),
  ];
  return (url) => {
    const date = url.searchParams.get("date");
    if (url.pathname === "/api/requests/sessions")
      return snapshot.schedule[date] ?? [];
    if (url.pathname === "/api/requests/professionals") return professionals;
    if (url.pathname === "/api/schedule") return snapshot.hours[date] ?? {};
    if (url.pathname === "/api/requests/upcoming")
      return {
        sessions: [],
        fromDate: snapshot.date,
        throughDate: snapshot.date,
        nextDate: null,
      };
    return null;
  };
}

export async function startDemoServer({ snapshot, port = 5180 } = {}) {
  process.env.VITE_CEDAR_PUBLIC_ASSISTANT = "1";
  const saved = snapshot && savedData(snapshot);
  const handler = snapshot
    ? assistantHandler(
        createPublicAssistant({
          demo: true,
          today: () => snapshot.date,
          matchIntent: createLocalIntentMatcher(),
          readHours: async (date) => snapshot.hours[date],
          readSessions: async (date) => snapshot.schedule[date] ?? [],
        }),
      )
    : assistant;
  // A built copy, so nothing reloads in the middle of a demo.
  const shared = {
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    logLevel: "warn",
    build: { outDir: join(tmpdir(), "cedar-demo-site"), emptyOutDir: true },
  };
  await build({ ...shared, plugins: [react()] });
  return preview({
    ...shared,
    preview: { host: "127.0.0.1", port, strictPort: true },
    plugins: [
      react(),
      {
        name: "cedar-demo-api",
        configurePreviewServer(vite) {
          vite.middlewares.use(async (req, res, next) => {
            const url = new URL(req.url, "http://localhost");
            if (!url.pathname.startsWith("/api/")) return next();
            if (url.pathname === "/api/public-assistant")
              return handler(req, res);
            const send = (status, body) => {
              res.statusCode = status;
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify(body));
            };
            if (req.method !== "GET") return send(405, {});
            if (url.pathname === "/api/patient-account/session")
              return send(401, {});
            if (saved) {
              const body = saved(url);
              return body ? send(200, body) : send(404, {});
            }
            try {
              const reply = await fetch(origin + url.pathname + url.search);
              return send(reply.status, await reply.json());
            } catch {
              return send(503, {});
            }
          });
        },
      },
    ],
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const path = process.argv[2];
  await startDemoServer({
    snapshot: path && JSON.parse(readFileSync(path, "utf8")),
  });
  console.log("Cedar demo: http://127.0.0.1:5180/");
}
