const { AppError } = require("../utils/app-error");

async function verifyWhyFolioToken(token, config = process.env) {
  const secret = config.WHYFOLIO_JWT_SECRET;
  const issuer = config.WHYFOLIO_JWT_ISSUER;
  const audience = config.WHYFOLIO_JWT_AUDIENCE;
  if (!secret || secret.length < 32 || !issuer || !audience) {
    throw new AppError(
      503,
      "AUTH_NOT_CONFIGURED",
      "WhyFolio JWT validation is not configured.",
    );
  }
  if (!token) {
    throw new AppError(
      401,
      "AUTHENTICATION_REQUIRED",
      "A WhyFolio bearer token is required.",
    );
  }

  try {
    const { jwtVerify } = await import("jose");
    const { payload } = await jwtVerify(
      token,
      new TextEncoder().encode(secret),
      {
        algorithms: ["HS256"],
        issuer,
        audience,
      },
    );
    if (
      !Number.isInteger(payload.exp) ||
      payload.exp <= Math.floor(Date.now() / 1000)
    ) {
      throw new AppError(
        401,
        "INVALID_TOKEN",
        "The WhyFolio bearer token must have a valid expiry.",
      );
    }
    const userId = payload.userId ?? payload.sub;
    if (typeof userId !== "string" || userId.length === 0) {
      throw new AppError(
        401,
        "INVALID_TOKEN",
        "The token does not identify a WhyFolio user.",
      );
    }
    return { userId, issuer: payload.iss, audience: payload.aud };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(
      401,
      "INVALID_TOKEN",
      "The WhyFolio bearer token is invalid or expired.",
    );
  }
}

function createWhyFolioAuth(config = process.env) {
  return async (req, res, next) => {
    const match = (req.get("authorization") ?? "").match(/^Bearer\s+(.+)$/i);
    try {
      req.auth = await verifyWhyFolioToken(match?.[1], config);
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

module.exports = { createWhyFolioAuth, verifyWhyFolioToken };
