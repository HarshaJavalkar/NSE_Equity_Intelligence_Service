const express = require("express");
const { z } = require("zod");
const createRateLimiters = require("../middleware/rate-limits");
const validateRequest = require("../middleware/request-validation");
const { createWhyFolioAuth } = require("../middleware/whyfolio-auth");
const { createApiKeyAuth } = require("../control-plane/api-key-auth");
const { AppError } = require("../utils/app-error");
const { sendSuccess } = require("../utils/http-response");

const sections = [
  "market",
  "fundamentals",
  "results",
  "announcements",
  "corporateActions",
  "surveillance",
  "delivery",
  "shortSelling",
  "marginTrading",
  "derived",
  "xbrl",
  "integratedFilings",
  "reports",
];
const sectionSchema = z.enum(sections);
const symbolSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9&.-]{1,30}$/);
const isinSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2}[A-Z0-9]{9}[0-9]$/);

function parseSectionQuery(query) {
  return query.sections === undefined ? undefined : query.sections.split(",");
}

function createMarketRouter({
  marketDataService,
  developerService,
  redisClient,
  authConfig,
  rateLimits,
} = {}) {
  const router = express.Router();
  const limiters = createRateLimiters(rateLimits, redisClient);
  const requireWhyFolioAuth = createWhyFolioAuth(authConfig);
  const requireApiKey = createApiKeyAuth(developerService);
  const sectionQuerySchema = z
    .object({ sections: z.string().optional() })
    .strict()
    .transform(parseSectionQuery)
    .pipe(z.array(sectionSchema).optional());

  router.use(
    "/api/v1/market",
    limiters.api,
    requireWhyFolioAuth,
    requireApiKey,
  );

  router.get("/api/v1/market/dataset/status", async (req, res) => {
    const data = await marketDataService.getDatasetStatus();
    return sendSuccess(res, { data, requestId: req.id });
  });

  router.get(
    "/api/v1/market/search",
    validateRequest({
      query: z
        .object({
          q: z.string().trim().min(2).max(100),
          limit: z.coerce.number().int().min(1).max(50).default(20),
        })
        .strict(),
    }),
    async (req, res) => {
      const { q, limit } = req.validated.query;
      const data = await marketDataService.search(q, limit);
      return sendSuccess(res, { data, requestId: req.id });
    },
  );

  router.post(
    "/api/v1/market/equities/batch",
    limiters.write,
    validateRequest({
      body: z
        .object({
          symbols: z.array(symbolSchema).min(1).max(100),
          sections: z.array(sectionSchema).optional(),
        })
        .strict(),
    }),
    async (req, res) => {
      const { symbols, sections: selectedSections } = req.validated.body;
      const data = await marketDataService.getBatch(symbols, selectedSections);
      return sendSuccess(res, { data, requestId: req.id });
    },
  );

  router.get(
    "/api/v1/market/securities/:isin",
    validateRequest({
      params: z.object({ isin: isinSchema }),
    }),
    async (req, res) => {
      const data = await marketDataService.getByIsin(req.validated.params.isin);
      return sendSuccess(res, { data, requestId: req.id });
    },
  );

  router.get(
    "/api/v1/market/equities/:symbol/:section",
    validateRequest({
      params: z.object({ symbol: symbolSchema, section: sectionSchema }),
    }),
    async (req, res) => {
      const { symbol, section } = req.validated.params;
      const data = await marketDataService.getBySymbol(symbol, [section]);
      return sendSuccess(res, { data, requestId: req.id });
    },
  );

  router.get(
    "/api/v1/market/equities/:symbol",
    validateRequest({
      params: z.object({ symbol: symbolSchema }),
      query: sectionQuerySchema,
    }),
    async (req, res) => {
      const { symbol } = req.validated.params;
      const data = await marketDataService.getBySymbol(
        symbol,
        req.validated.query,
      );
      return sendSuccess(res, { data, requestId: req.id });
    },
  );

  router.use((req, res, next) =>
    next(
      new AppError(
        404,
        "ROUTE_NOT_FOUND",
        "The requested market-data route does not exist.",
      ),
    ),
  );

  return router;
}

module.exports = { createMarketRouter };
