const express = require("express");
const helmet = require("helmet");
const createRateLimiters = require("./middleware/rate-limits");
const requestId = require("./middleware/request-id");
const { errorHandler, notFoundHandler } = require("./middleware/error-handler");
const { AppError } = require("./utils/app-error");
const { sendSuccess } = require("./utils/http-response");
const { createServiceAuth } = require("./middleware/service-auth");
const { MarketRepository } = require("./redis/market-repository");
const { MarketDataService } = require("./services/market-data-service");
const { createMarketRouter } = require("./routes/market-router");
const { DeveloperService } = require("./services/developer-service");
const { createControlPlaneRouter } = require("./control-plane/routes");
const { MarketTestService } = require("./services/market-test-service");
const { NseIngestionService } = require("./ingestion/nse-ingestion-service");
const {
  NseIngestionCoordinator,
} = require("./ingestion/nse-ingestion-coordinator");
const { NseReportArchive } = require("./ingestion/nse-report-archive");

function createApp(options = {}) {
  const app = express();
  const { redisClient = null } = options;
  const repository =
    options.marketRepository ?? new MarketRepository(redisClient);
  const marketDataService =
    options.marketDataService ?? new MarketDataService(repository);
  const developerService =
    options.developerService ??
    new DeveloperService(
      options.developerRepository,
      options.developerAuthConfig,
    );
  const marketTestService =
    options.marketTestService ??
    new MarketTestService({
      developerService,
      marketDataService,
    });
  const nseIngestionService =
    options.nseIngestionService ??
    new NseIngestionService({
      redisClient,
      archiveService: options.nseReportArchive ?? new NseReportArchive(),
    });
  const nseIngestionCoordinator =
    options.nseIngestionCoordinator ??
    new NseIngestionCoordinator({
      redisClient,
      ingestionService: nseIngestionService,
    });
  const limiters = createRateLimiters(options.rateLimits, redisClient);
  const requireServiceAuth = createServiceAuth(options.serviceAuthConfig);
  const marketRouter = createMarketRouter({
    marketDataService,
    developerService,
    redisClient,
    authConfig: options.authConfig,
    rateLimits: options.rateLimits,
  });
  const controlPlaneRouter = createControlPlaneRouter({
    developerService,
    marketTestService,
    redisClient,
    rateLimits: options.rateLimits,
    authConfig: options.developerAuthConfig,
    nseIngestionCoordinator,
  });

  app.disable("x-powered-by");
  app.use(requestId);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          scriptSrc: ["'self'", "https://accounts.google.com/gsi/client"],
          frameSrc: ["'self'", "https://accounts.google.com/gsi/"],
          connectSrc: ["'self'", "https://accounts.google.com/gsi/"],
        },
      },
    }),
  );
  app.use(express.json({ limit: "32kb", strict: true }));
  app.use(limiters.global);

  app.get("/health", async (req, res) =>
    sendSuccess(res, {
      data: { status: "UP" },
      requestId: req.id,
    }),
  );

  app.get("/health/redis", requireServiceAuth, async (req, res) => {
    const available = await repository.ping();
    return sendSuccess(res, {
      data: { status: available ? "UP" : "DOWN" },
      requestId: req.id,
    });
  });

  app.get("/health/ready", requireServiceAuth, async (req, res) => {
    const data = await marketDataService.getReadiness();
    return sendSuccess(res, { data, requestId: req.id });
  });

  app.get(
    "/health/control-plane",
    requireServiceAuth,
    async (req, res, next) => {
      if (!options.developerRepository?.isReady) {
        return next(
          new AppError(
            503,
            "CONTROL_PLANE_UNAVAILABLE",
            "Developer account storage is not connected.",
          ),
        );
      }
      return sendSuccess(res, {
        data: { status: "UP" },
        requestId: req.id,
      });
    },
  );

  app.get("/health/nse", requireServiceAuth, async (req, res) => {
    const dataset = await marketDataService.getDatasetStatus();
    return sendSuccess(res, {
      data: {
        status: "UP",
        dataset: dataset.status,
        tradeDate: dataset.tradeDate,
        datasetVersion: dataset.datasetVersion,
      },
      requestId: req.id,
    });
  });

  app.post(
    "/api/v1/internal/nse/fetch",
    limiters.write,
    requireServiceAuth,
    async (req, res) => {
      const result = await nseIngestionCoordinator.start({
        trigger: "INTERNAL_API",
      });
      return sendSuccess(res, {
        data: result,
        statusCode: result.accepted ? 202 : 409,
        requestId: req.id,
      });
    },
  );

  app.use(controlPlaneRouter);
  app.use(marketRouter);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
