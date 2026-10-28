const { createHmac } = require("node:crypto");

const DEVELOPER_SESSION_DOMAIN = "whyfolio-market-core:developer-session:v1";
const MIN_SECRET_LENGTH = 32;

function resolveDeveloperSessionKey(config = process.env) {
  const source = config.DEVELOPER_JWT_SECRET
    ? "DEVELOPER_JWT_SECRET"
    : config.WHYFOLIO_JWT_SECRET
      ? "WHYFOLIO_JWT_SECRET"
      : config.GOOGLE_CLIENT_SECRET
        ? "GOOGLE_CLIENT_SECRET"
        : null;
  const secret = source ? config[source] : null;

  if (typeof secret !== "string" || secret.length < MIN_SECRET_LENGTH) {
    return null;
  }

  return createHmac("sha256", secret).update(DEVELOPER_SESSION_DOMAIN).digest();
}

module.exports = { resolveDeveloperSessionKey };
