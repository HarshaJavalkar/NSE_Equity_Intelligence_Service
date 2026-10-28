const { AppError } = require("../utils/app-error");

class GoogleAuthClient {
  constructor(config = process.env) {
    this.config = config;
  }

  async authenticate({ credential, code }) {
    if (Boolean(credential) === Boolean(code)) {
      throw new AppError(
        400,
        "INVALID_GOOGLE_AUTH_REQUEST",
        "Provide either a Google credential or authorization code.",
      );
    }

    const clientId = this.config.GOOGLE_CLIENT_ID;
    if (!clientId) {
      throw new AppError(
        503,
        "GOOGLE_AUTH_NOT_CONFIGURED",
        "Google sign-in is not configured.",
      );
    }

    let idToken = credential;
    let accessToken = null;
    if (code) {
      ({ idToken, accessToken } = await this.#exchangeCode(code, clientId));
    }

    const claims = await this.#verifyIdToken(idToken, clientId);
    let userInfo = claims;
    if (accessToken) {
      userInfo = await this.#getUserInfo(accessToken);
      if (userInfo.sub !== claims.sub) {
        throw new AppError(
          401,
          "INVALID_GOOGLE_CREDENTIAL",
          "Google identity did not match the verified ID token.",
        );
      }
    }

    const email = (claims.email || userInfo.email || "").trim().toLowerCase();
    const emailVerified =
      claims.email_verified === true || claims.email_verified === "true";
    if (!email || !claims.sub || !emailVerified) {
      throw new AppError(
        401,
        "INVALID_GOOGLE_CREDENTIAL",
        "Google must provide a verified email and valid identity.",
      );
    }

    return {
      googleSub: claims.sub,
      email,
      name: userInfo.name || claims.name || email.split("@")[0],
    };
  }

  async #verifyIdToken(idToken, clientId) {
    const tokenInfoUrl = this.config.GOOGLE_OAUTH_TOKENINFO_URL;
    if (!tokenInfoUrl) {
      throw new AppError(
        503,
        "GOOGLE_AUTH_NOT_CONFIGURED",
        "GOOGLE_OAUTH_TOKENINFO_URL is not configured.",
      );
    }

    let tokenInfo;
    try {
      const url = new URL(tokenInfoUrl);
      url.searchParams.set("id_token", idToken);
      tokenInfo = await this.#fetchJson(url, { method: "GET" });
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(
        502,
        "GOOGLE_PROVIDER_UNAVAILABLE",
        "Google token verification is unavailable.",
      );
    }

    const expiry = Number(tokenInfo.exp);
    const issuerIsValid = [
      "accounts.google.com",
      "https://accounts.google.com",
    ].includes(tokenInfo.iss);
    if (
      tokenInfo.aud !== clientId ||
      !issuerIsValid ||
      !Number.isFinite(expiry) ||
      expiry <= Math.floor(Date.now() / 1000)
    ) {
      throw new AppError(
        401,
        "INVALID_GOOGLE_CREDENTIAL",
        "Google ID token is invalid, expired, or issued for another client.",
      );
    }
    return tokenInfo;
  }

  async #exchangeCode(code, clientId) {
    const tokenUrl = this.config.GOOGLE_OAUTH_TOKEN_URL;
    const clientSecret = this.config.GOOGLE_CLIENT_SECRET;
    if (!tokenUrl || !clientSecret) {
      throw new AppError(
        503,
        "GOOGLE_AUTH_NOT_CONFIGURED",
        "Google authorization-code exchange is not configured.",
      );
    }

    const form = new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: "postmessage",
      grant_type: "authorization_code",
    });
    const tokens = await this.#fetchJson(tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form,
    });
    if (!tokens.id_token || !tokens.access_token) {
      throw new AppError(
        401,
        "INVALID_GOOGLE_CREDENTIAL",
        "Google did not return valid OAuth tokens.",
      );
    }
    return { idToken: tokens.id_token, accessToken: tokens.access_token };
  }

  async #getUserInfo(accessToken) {
    const userInfoUrl = this.config.GOOGLE_OAUTH_USERINFO_URL;
    if (!userInfoUrl) {
      throw new AppError(
        503,
        "GOOGLE_AUTH_NOT_CONFIGURED",
        "GOOGLE_OAUTH_USERINFO_URL is not configured.",
      );
    }
    return this.#fetchJson(userInfoUrl, {
      method: "GET",
      headers: { authorization: `Bearer ${accessToken}` },
    });
  }

  async #fetchJson(url, options) {
    let response;
    try {
      response = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      throw new AppError(
        502,
        "GOOGLE_PROVIDER_UNAVAILABLE",
        "Google authentication service could not be reached.",
      );
    }
    if (!response.ok) {
      throw new AppError(
        401,
        "INVALID_GOOGLE_CREDENTIAL",
        "Google rejected the authentication request.",
      );
    }
    try {
      return await response.json();
    } catch {
      throw new AppError(
        502,
        "GOOGLE_PROVIDER_INVALID_RESPONSE",
        "Google returned an invalid authentication response.",
      );
    }
  }
}

module.exports = { GoogleAuthClient };
