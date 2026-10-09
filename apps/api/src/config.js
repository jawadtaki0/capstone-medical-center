import "dotenv/config";

const parsedPort = Number.parseInt(process.env.PORT ?? "4000", 10);

export const config = Object.freeze({
  port: Number.isNaN(parsedPort) ? 4000 : parsedPort,
  clientOrigin: process.env.CLIENT_ORIGIN ?? "http://localhost:5173",
  mongoUri: process.env.MONGODB_URI?.trim() || null,
  mongoDbName: process.env.MONGODB_DB_NAME?.trim() || "medical_center_capstone",
});
