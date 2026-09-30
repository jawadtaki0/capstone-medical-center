import cors from "cors";
import express from "express";
import helmet from "helmet";
import { config } from "./config.js";
import { getDatabaseStatus } from "./db.js";
import { getBeirutToday, getScheduleForDate, isValidScheduleDate } from "./schedule.js";

export function createApp({ scheduleReader = getScheduleForDate } = {}) {
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

  app.get("/api/schedule", async (request, response) => {
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
  });

  app.use((request, response) => {
    response.status(404).json({
      error: "not_found",
      message: `No route for ${request.method} ${request.path}`,
    });
  });

  return app;
}
