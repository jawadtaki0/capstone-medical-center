import cors from "cors";
import express from "express";
import helmet from "helmet";
import { config } from "./config.js";
import { checkDatabaseHealth } from "./db.js";
import { getPublicProfessionals } from "./professionals.js";
import { createPublicDataGate } from "./public-data-gate.js";
import {
  getBeirutToday,
  getScheduleForDate,
  isValidScheduleDate,
} from "./schedule.js";

export function createApp({
  scheduleReader = getScheduleForDate,
  professionalsReader = getPublicProfessionals,
  databaseHealthReader = checkDatabaseHealth,
  publicDataGate = createPublicDataGate(),
} = {}) {
  const app = express();

  app.disable("x-powered-by");
  app.use(helmet());
  app.use(cors({ origin: config.clientOrigin }));
  app.use(express.json({ limit: "100kb" }));

  app.get("/api/health", async (_request, response) => {
    response.json({
      service: "medical-center-api",
      status: "ok",
      database: await databaseHealthReader(),
      publicData: publicDataGate.status(),
    });
  });

  app.get(
    "/api/schedule",
    publicDataGate.guard(async (request, response) => {
      const date = request.query.date ?? getBeirutToday();
      if (!isValidScheduleDate(date)) {
        response.status(400).json({
          error: "invalid_date",
          message: "Use a real calendar date in YYYY-MM-DD format.",
        });
        return;
      }
      try {
        response.json(await scheduleReader(date));
      } catch (error) {
        console.error(`Schedule read failed: ${error.message}`);
        response.status(503).json({
          error: "schedule_unavailable",
          message: "The public schedule could not be loaded right now.",
        });
      }
    }),
  );

  app.get(
    "/api/professionals",
    publicDataGate.guard(async (_request, response) => {
      try {
        response.json(await professionalsReader());
      } catch {
        console.error("Public directory read failed.");
        response.status(503).json({
          error: "directory_unavailable",
          message:
            "The doctors and specialists directory could not be loaded right now.",
        });
      }
    }),
  );

  app.use((request, response) => {
    response.status(404).json({
      error: "not_found",
      message: `No route for ${request.method} ${request.path}`,
    });
  });

  return app;
}
