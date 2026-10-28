const path = require("node:path");
require("dotenv").config({ path: path.resolve(__dirname, "../../../.env") });

const { createRedisClient } = require("../redis/client");
const { ensureRedisReady } = require("../redis/startup");
const { NseIngestionService } = require("./nse-ingestion-service");
const { NseReportArchive } = require("./nse-report-archive");

async function main() {
  await ensureRedisReady();
  const redisClient = createRedisClient();
  if (!redisClient) throw new Error("REDIS_URL is not configured.");
  redisClient.on("error", (error) => {
    console.error({ event: "redis_error", message: error.message });
  });

  try {
    await redisClient.connect();
    const result = await new NseIngestionService({
      redisClient,
      archiveService: new NseReportArchive(),
    }).run();
    console.log(JSON.stringify({ event: "nse_dataset_published", ...result }));
  } finally {
    if (redisClient.isOpen) await redisClient.quit();
  }
}

main().catch((error) => {
  console.error({
    event: "nse_ingestion_failed",
    message: error.message,
    code: error.code ?? "NSE_INGESTION_FAILED",
  });
  process.exitCode = 1;
});
