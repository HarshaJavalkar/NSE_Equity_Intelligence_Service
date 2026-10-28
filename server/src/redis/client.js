const { createClient } = require("redis");

function createRedisClient({
  url = process.env.REDIS_URL ?? "redis://127.0.0.1:6379",
  logger = console,
} = {}) {
  if (!url) return null;

  const client = createClient({
    url,
    socket: {
      reconnectStrategy: (retries) => Math.min(retries * 250, 5000),
    },
  });

  client.on("error", (error) => {
    logger.error({ event: "redis_error", message: error.message });
  });

  return client;
}

module.exports = { createRedisClient };
