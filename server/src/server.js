const path = require("node:path");
const dns = require("node:dns");

require("dotenv").config({ path: path.resolve(__dirname, "../../.env") });

if (process.env.MONGODB_URI?.startsWith("mongodb+srv://")) {
  const dnsServers = (
    process.env.MONGODB_DNS_SERVERS || "8.8.8.8,8.8.4.4,1.1.1.1"
  )
    .split(",")
    .map((server) => server.trim())
    .filter(Boolean);

  try {
    dns.setServers(dnsServers);
    console.log({ event: "mongodb_dns_servers_configured" });
  } catch (error) {
    console.error({
      event: "mongodb_dns_configuration_failed",
      code: error.code ?? "DNS_CONFIGURATION_ERROR",
    });
  }
}

const { createApp } = require("./app");
const { createRedisClient } = require("./redis/client");
const { ensureRedisReady } = require("./redis/startup");
const { NseIngestionService } = require("./ingestion/nse-ingestion-service");
const {
  NseIngestionCoordinator,
} = require("./ingestion/nse-ingestion-coordinator");
const {
  NseIngestionScheduler,
} = require("./ingestion/nse-ingestion-scheduler");
const { NseReportArchive } = require("./ingestion/nse-report-archive");
const mongoose = require("mongoose");
const { ControlPlaneRepository } = require("./control-plane/repository");

async function startServer() {
  const port = Number.parseInt(process.env.API_PORT ?? "3000", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("API_PORT must be a valid TCP port.");
  }

  await ensureRedisReady();
  const redisClient = createRedisClient();
  await redisClient.connect();
  const response = await redisClient.ping();
  if (response !== "PONG") throw new Error("Unexpected Redis PING response");
  console.log({ event: "redis_connected", response });

  let developerRepository = null;
  const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (mongoUri) {
    const mongoOptions = {
      serverSelectionTimeoutMS: 15000,
      socketTimeoutMS: 45000,
      family: 4,
      tls: true,
      dbName: process.env.MONGODB_DB_NAME || undefined,
    };
    developerRepository = new ControlPlaneRepository();
    mongoose
      .connect(mongoUri, mongoOptions)
      .then(() => developerRepository.initialize())
      .then(() => console.log({ event: "mongodb_control_plane_ready" }))
      .catch((error) => {
        console.error({
          event: "mongodb_connect_failed",
          code: error.code ?? "MONGODB_ERROR",
          host: new URL(mongoUri).hostname,
          database: process.env.MONGODB_DB_NAME || "URI_DEFAULT",
        });
      });
  } else {
    console.error({
      event: "mongodb_connect_skipped",
      reason: "MONGODB_URI or MONGO_URI is not configured",
    });
  }

  const nseIngestionService = new NseIngestionService({
    redisClient,
    archiveService: new NseReportArchive(),
  });
  const nseIngestionCoordinator = new NseIngestionCoordinator({
    redisClient,
    ingestionService: nseIngestionService,
  });
  const nseIngestionScheduler = new NseIngestionScheduler({
    coordinator: nseIngestionCoordinator,
  });
  const app = createApp({
    redisClient,
    developerRepository,
    nseIngestionService,
    nseIngestionCoordinator,
  });
  const server = app.listen(port, () => {
    console.log(`WhyFolio market core listening on port ${port}`);
    nseIngestionScheduler.start();
  });

  function shutdown(signal) {
    console.log(`${signal} received; closing HTTP server.`);
    nseIngestionScheduler.stop();
    server.close((error) => {
      if (error) {
        console.error(error);
        process.exitCode = 1;
      }
      if (redisClient.isOpen) {
        redisClient.quit().catch((redisError) => {
          console.error({
            event: "redis_shutdown_failed",
            message: redisError.message,
          });
          process.exitCode = 1;
        });
      }
      if (mongoose.connection.readyState !== 0) {
        mongoose.disconnect().catch((mongoError) => {
          console.error({
            event: "mongodb_shutdown_failed",
            message: mongoError.message,
          });
          process.exitCode = 1;
        });
      }
    });
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

startServer().catch((error) => {
  console.error({
    event: "startup_failed",
    message: error.message,
    code: error.code ?? "STARTUP_ERROR",
  });
  process.exitCode = 1;
});
