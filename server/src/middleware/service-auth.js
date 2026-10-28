const { createHash, timingSafeEqual } = require("node:crypto");
const { AppError } = require("../utils/app-error");

function createServiceAuth(config = process.env) {
  return (req, res, next) => {
    const expected = config.SERVICE_TO_SERVICE_TOKEN;
    if (!expected) {
      return next(
        new AppError(
          503,
          "SERVICE_AUTH_NOT_CONFIGURED",
          "Internal service authentication is not configured.",
        ),
      );
    }

    const match = (req.get("authorization") ?? "").match(/^Bearer\s+(.+)$/i);
    if (!match) {
      return next(
        new AppError(
          401,
          "SERVICE_AUTH_REQUIRED",
          "An internal service credential is required.",
        ),
      );
    }

    const expectedHash = createHash("sha256").update(expected).digest();
    const providedHash = createHash("sha256").update(match[1]).digest();
    if (!timingSafeEqual(expectedHash, providedHash)) {
      return next(
        new AppError(
          401,
          "INVALID_SERVICE_CREDENTIAL",
          "The internal service credential is invalid.",
        ),
      );
    }

    next();
  };
}

module.exports = { createServiceAuth };
