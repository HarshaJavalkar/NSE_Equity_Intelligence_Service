const { rateLimit } = require("express-rate-limit");
const { RedisStore } = require("rate-limit-redis");
const { sendError } = require("../utils/http-response");

function createRateLimiters(overrides = {}, redisClient = null) {
  const createLimiter = (name, windowMs, limit, message) =>
    rateLimit({
      windowMs,
      limit,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      ...(redisClient
        ? {
            store: new RedisStore({
              prefix: `whyfolio:market:ratelimit:${name}:`,
              sendCommand: (...args) => redisClient.sendCommand(args),
            }),
          }
        : {}),
      handler: (req, res) =>
        sendError(res, {
          statusCode: 429,
          code: "RATE_LIMIT_EXCEEDED",
          message,
          requestId: req.id,
          details: { retryAfterSeconds: res.getHeader("Retry-After") ?? null },
        }),
    });

  return {
    global: createLimiter(
      "global",
      15 * 60 * 1000,
      overrides.globalLimit ?? 120,
      "Too many requests.",
    ),
    api: createLimiter(
      "api",
      60 * 1000,
      overrides.apiLimit ?? 30,
      "API request limit exceeded.",
    ),
    write: createLimiter(
      "write",
      60 * 1000,
      overrides.writeLimit ?? 5,
      "Write request limit exceeded.",
    ),
  };
}

module.exports = createRateLimiters;
