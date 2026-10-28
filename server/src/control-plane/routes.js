const express = require("express");
const { z } = require("zod");
const createRateLimiters = require("../middleware/rate-limits");
const validateRequest = require("../middleware/request-validation");
const { createDeveloperAuth } = require("./developer-auth");
const { endpointCatalog } = require("./endpoint-catalog");
const { sendSuccess } = require("../utils/http-response");
const { AppError } = require("../utils/app-error");

const googleCredentialSchema = z
  .object({
    credential: z.string().min(100).max(10000).optional(),
    code: z.string().min(10).max(4096).optional(),
    organization: z.string().trim().min(2).max(120).optional(),
  })
  .strict()
  .refine((auth) => Boolean(auth.credential) !== Boolean(auth.code), {
    message: "Provide exactly one Google credential or authorization code.",
  });
const keySchema = z
  .object({
    name: z.string().trim().min(2).max(80),
    scopes: z.array(z.string().min(1)).min(1).max(endpointCatalog.length),
  })
  .strict();
const keyParamsSchema = z.object({ keyId: z.string().regex(/^[a-f\d]{24}$/i) });
const testRequestSchema = z
  .object({
    endpointId: z.enum(endpointCatalog.map((endpoint) => endpoint.id)),
    method: z.enum(["GET", "POST"]),
    params: z.record(z.string(), z.string()).default({}),
    query: z.record(z.string(), z.string()).default({}),
    body: z.record(z.string(), z.unknown()).optional(),
    apiKey: z.string().min(16).max(256),
  })
  .strict();

function createControlPlaneRouter({
  developerService,
  marketTestService,
  redisClient,
  rateLimits,
  authConfig,
  nseIngestionCoordinator,
  ingestionOperatorEmails = process.env.NSE_INGESTION_OPERATOR_EMAILS ?? "",
} = {}) {
  const router = express.Router();
  const limiters = createRateLimiters(rateLimits, redisClient);
  const requireDeveloperAuth = createDeveloperAuth(authConfig);
  const operatorEmails = new Set(
    ingestionOperatorEmails
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );

  const requireNseOperator = async (req, res, next) => {
    if (!operatorEmails.size) {
      return next(
        new AppError(
          503,
          "NSE_INGESTION_OPERATOR_NOT_CONFIGURED",
          "Manual NSE ingestion is disabled until NSE_INGESTION_OPERATOR_EMAILS is configured.",
        ),
      );
    }
    try {
      const profile = await developerService.getProfile(req.developer.userId);
      const email = profile.email?.trim().toLowerCase();
      if (!operatorEmails.has("*") && (!email || !operatorEmails.has(email))) {
        return next(
          new AppError(
            403,
            "NSE_INGESTION_FORBIDDEN",
            "This developer account is not authorized to run NSE ingestion.",
          ),
        );
      }
      return next();
    } catch (error) {
      return next(error);
    }
  };

  router.get("/api/v1/developer/auth-config", async (req, res) => {
    const data = developerService.getGoogleAuthConfig();
    return sendSuccess(res, { data, requestId: req.id });
  });

  router.post(
    "/api/v1/developer/google",
    limiters.write,
    validateRequest({
      body: googleCredentialSchema,
    }),
    async (req, res) => {
      const data = await developerService.authenticateWithGoogle(
        req.validated.body,
      );
      return sendSuccess(res, { data, requestId: req.id });
    },
  );

  router.use("/api/v1/developer", limiters.api, requireDeveloperAuth);

  router.get(
    "/api/v1/developer/nse/ingestion",
    requireNseOperator,
    async (req, res) => {
      const data = await nseIngestionCoordinator.getStatus();
      return sendSuccess(res, { data, requestId: req.id });
    },
  );

  router.post(
    "/api/v1/developer/nse/ingestion",
    limiters.write,
    requireNseOperator,
    validateRequest({
      body: z
        .object({
          tradeDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          force: z.boolean().optional(),
        })
        .strict()
        .optional(),
    }),
    async (req, res) => {
      const options = req.validated?.body ?? {};
      const result = await nseIngestionCoordinator.start({
        trigger: "MANUAL_UI",
        requestedBy: req.developer.userId,
        expectedTradeDate: options.tradeDate ?? null,
        force: Boolean(options.force),
        skipIfCurrent: !options.force,
      });
      return sendSuccess(res, {
        data: result,
        statusCode: result.accepted ? 202 : 409,
        requestId: req.id,
      });
    },
  );

  router.post(
    "/api/v1/developer/try",
    limiters.write,
    validateRequest({
      body: testRequestSchema,
    }),
    async (req, res) => {
      const result = await marketTestService.execute(
        req.developer.userId,
        req.validated.body,
      );
      return sendSuccess(res, { data: result, requestId: req.id });
    },
  );

  router.get("/api/v1/developer/profile", async (req, res) => {
    const data = await developerService.getProfile(req.developer.userId);
    return sendSuccess(res, { data, requestId: req.id });
  });

  router.patch(
    "/api/v1/developer/profile",
    validateRequest({
      body: z
        .object({
          name: z.string().trim().min(2).max(100).optional(),
          organization: z.string().trim().min(2).max(120).optional(),
        })
        .strict()
        .refine((profile) => Object.keys(profile).length > 0),
    }),
    async (req, res) => {
      const data = await developerService.updateProfile(
        req.developer.userId,
        req.validated.body,
      );
      return sendSuccess(res, { data, requestId: req.id });
    },
  );

  router.get("/api/v1/developer/endpoints", async (req, res) =>
    sendSuccess(res, { data: endpointCatalog, requestId: req.id }),
  );

  router.get("/api/v1/developer/api-keys", async (req, res) => {
    const data = await developerService.listApiKeys(req.developer.userId);
    return sendSuccess(res, { data, requestId: req.id });
  });

  router.post(
    "/api/v1/developer/api-keys",
    limiters.write,
    validateRequest({
      body: keySchema,
    }),
    async (req, res) => {
      const data = await developerService.createApiKey(
        req.developer.userId,
        req.validated.body,
      );
      return sendSuccess(res, { data, statusCode: 201, requestId: req.id });
    },
  );

  router.patch(
    "/api/v1/developer/api-keys/:keyId/scopes",
    validateRequest({
      params: keyParamsSchema,
      body: z
        .object({
          scopes: z.array(z.string().min(1)).min(1).max(endpointCatalog.length),
        })
        .strict(),
    }),
    async (req, res) => {
      const data = await developerService.updateApiKeyScopes(
        req.developer.userId,
        req.validated.params.keyId,
        req.validated.body.scopes,
      );
      return sendSuccess(res, { data, requestId: req.id });
    },
  );

  router.delete(
    "/api/v1/developer/api-keys/:keyId",
    validateRequest({
      params: keyParamsSchema,
    }),
    async (req, res) => {
      const data = await developerService.revokeApiKey(
        req.developer.userId,
        req.validated.params.keyId,
      );
      return sendSuccess(res, { data, requestId: req.id });
    },
  );

  router.get(
    "/api/v1/developer/usage",
    validateRequest({
      query: z
        .object({
          days: z.coerce.number().int().min(1).max(90).default(30),
        })
        .strict(),
    }),
    async (req, res) => {
      const data = await developerService.getUsage(
        req.developer.userId,
        req.validated.query.days,
      );
      return sendSuccess(res, { data, requestId: req.id });
    },
  );

  return router;
}

module.exports = { createControlPlaneRouter };
