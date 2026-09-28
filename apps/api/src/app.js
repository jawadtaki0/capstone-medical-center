import cors from "cors";
import express from "express";
import helmet from "helmet";
import { config } from "./config.js";
import { getDatabaseStatus } from "./db.js";

export function createApp() {
  const app = express();

  app.disable("x-powered-by");
  app.use(helmet());
  app.use(cors({ origin: config.clientOrigin }));
  app.use(express.json({ limit: "100kb" }));

  app.get("/api/health", (_request, response) => {
    response.json({
      service: "medical-center-api",
      status: "ok",
      database: getDatabaseStatus(),
    });
  });

  app.use((request, response) => {
    response.status(404).json({
      error: "not_found",
      message: `No route for ${request.method} ${request.path}`,
    });
  });

  return app;
}

