const { AppError } = require("../utils/app-error");
const { resolveDeveloperSessionKey } = require("./developer-session-secret");

function createDeveloperAuth(config = process.env) {
  let joseModule;
  const signingKey = resolveDeveloperSessionKey(config);
  return async (req, res, next) => {
    if (!signingKey) {
      return next(
        new AppError(
          503,
          "DEVELOPER_AUTH_NOT_CONFIGURED",
          "Developer authentication is not configured.",
        ),
      );
    }
    const match = (req.get("authorization") ?? "").match(/^Bearer\s+(.+)$/i);
    if (!match)
      return next(
        new AppError(
          401,
          "AUTHENTICATION_REQUIRED",
          "A developer bearer token is required.",
        ),
      );

    try {
      joseModule ??= import("jose");
      const { jwtVerify } = await joseModule;
      const { payload } = await jwtVerify(match[1], signingKey, {
        algorithms: ["HS256"],
        issuer: config.DEVELOPER_JWT_ISSUER || "whyfolio-market-core-developer",
        audience: config.DEVELOPER_JWT_AUDIENCE || "whyfolio-developer-portal",
      });
      if (
        typeof payload.userId !== "string" ||
        !Number.isInteger(payload.exp)
      ) {
        throw new AppError(
          401,
          "INVALID_SESSION",
          "Developer token claims are incomplete.",
        );
      }
      req.developer = { userId: payload.userId };
      next();
    } catch (error) {
      next(
        error instanceof AppError
          ? error
          : new AppError(
              401,
              "INVALID_SESSION",
              "Developer session is invalid or expired.",
            ),
      );
    }
  };
}

module.exports = { createDeveloperAuth };
