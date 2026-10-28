const { AppError } = require("../utils/app-error");
const { endpointById, identifyEndpoint } = require("./endpoint-catalog");

function createApiKeyAuth(developerService) {
  return async (req, res, next) => {
    const endpointId = identifyEndpoint(req.method, req.originalUrl);
    if (!endpointId) {
      return next(
        new AppError(
          403,
          "ENDPOINT_NOT_MAPPED",
          "This route is not available to developer API keys.",
        ),
      );
    }
    const secret = req.get("x-api-key");
    if (!secret)
      return next(
        new AppError(
          401,
          "API_KEY_REQUIRED",
          "An endpoint-scoped API key is required.",
        ),
      );

    try {
      const key = await developerService.validateApiKey(secret, endpointId);
      const endpoint = endpointById.get(endpointId);
      req.apiCredential = { id: key._id, ownerId: key.ownerId, endpointId };
      res.once("finish", () => {
        developerService
          .recordUsage({
            ownerId: key.ownerId,
            apiKeyId: key._id,
            endpointId,
            endpoint: `${endpoint.method} ${endpoint.path}`,
            statusCode: res.statusCode,
          })
          .catch((error) => {
            console.error({
              event: "usage_record_failed",
              endpointId,
              message: error.message,
            });
          });
      });
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

module.exports = { createApiKeyAuth };
