import { websiteRequestRouter } from "./website-request-routes.js";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import { config } from "./config.js";
import { checkDatabaseHealth } from "./db.js";
import { getPublicProfessionals } from "./professionals.js";
import { createPublicDataGate } from "./public-data-gate.js";
import {
  MAX_PUBLICATION_BYTES,
  PublicationError,
} from "../../../shared/publication-contract.mjs";
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
  publicationReceiver = null,
  publicAuthority = null,
  websiteDirectory = null,
  websiteRequests = null,
  clientOrigin = config.clientOrigin,
} = {}) {
  const app = express();

  app.disable("x-powered-by");
  app.use(helmet());
  app.use("/track", (_request, response, next) => {
    response.set({
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex, nofollow",
    });
    next();
  });
  app.use(cors({ origin: clientOrigin }));
  if (publicationReceiver) {
    const legacySchedule = scheduleReader,
      legacyProfessionals = professionalsReader;
    scheduleReader = async (date) =>
      !publicAuthority || (await publicAuthority.mode()) === "cedar"
        ? publicationReceiver.schedule(date)
        : legacySchedule(date);
    professionalsReader = async () =>
      !publicAuthority || (await publicAuthority.mode()) === "cedar"
        ? publicationReceiver.professionals()
        : legacyProfessionals();
    databaseHealthReader = publicationReceiver.health;
    app.use("/api", (_request, response, next) => {
      response.set("Cache-Control", "no-store");
      next();
    });
    app.post(
      "/api/publications",
      (request, response, next) =>
        publicationReceiver.authorized(request)
          ? next()
          : response.status(401).json({
              error: "publication_authentication_failed",
              message: "Publication authentication is required.",
            }),
      express.json({
        limit: MAX_PUBLICATION_BYTES,
        strict: true,
        inflate: false,
      }),
      async (request, response) => {
        try {
          response.json(await publicationReceiver.accept(request.body));
        } catch (error) {
          response
            .status(error instanceof PublicationError ? error.status : 503)
            .json({
              error:
                error instanceof PublicationError
                  ? error.code
                  : "publication_unavailable",
              message:
                "The publication was not accepted. The previous public version is unchanged.",
            });
        }
      },
      (error, _request, response, _next) =>
        response.status(error.type === "entity.too.large" ? 413 : 400).json({
          error: "invalid_publication",
          message: "Send one complete publication within the permitted size.",
        }),
    );
  }
  if (websiteRequests)
    app.use("/api/requests", websiteRequestRouter(websiteRequests));
  app.use(express.json({ limit: "100kb", inflate: false }));
  app.use((error, _request, response, next) => {
    if (
      ![
        "encoding.unsupported",
        "entity.parse.failed",
        "entity.too.large",
      ].includes(error.type)
    )
      return next(error);
    response
      .status(
        error.type === "entity.too.large"
          ? 413
          : error.type === "encoding.unsupported"
            ? 415
            : 400,
      )
      .json({
        error: "invalid_json",
        message: "Send uncompressed JSON within the permitted size.",
      });
  });

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
      } catch {
        console.error("Schedule read failed.");
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

  if (websiteDirectory) {
    app.use(express.static(websiteDirectory));
    app.get(
      ["/", "/doctors", "/schedule", "/request", "/track"],
      (_request, response) =>
        response.sendFile("index.html", { root: websiteDirectory }),
    );
  }
  app.use((request, response) => {
    response.status(404).json({
      error: "not_found",
      message: `No route for ${request.method} ${request.path}`,
    });
  });

  return app;
}
