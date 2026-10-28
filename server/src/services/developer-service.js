const { randomBytes, createHash } = require("node:crypto");
const { Types } = require("mongoose");
const { ObjectId } = Types;
const { GoogleAuthClient } = require("../control-plane/google-auth-client");
const { resolveDeveloperSessionKey } = require("../control-plane/developer-session-secret");
const { endpointById, endpointCatalog } = require("../control-plane/endpoint-catalog");
const { AppError } = require("../utils/app-error");

class DeveloperService {
  constructor(repository, config = process.env) {
    this.repository = repository;
    this.config = config;
    this.googleAuth = new GoogleAuthClient(config);
  }

  getGoogleAuthConfig() {
    if (
      !this.config.GOOGLE_CLIENT_ID ||
      !this.config.GOOGLE_CLIENT_SECRET ||
      !this.config.GOOGLE_OAUTH_TOKEN_URL ||
      !this.config.GOOGLE_OAUTH_USERINFO_URL ||
      !this.config.GOOGLE_OAUTH_TOKENINFO_URL
    ) {
      throw new AppError(
        503,
        "GOOGLE_AUTH_NOT_CONFIGURED",
        "Google OAuth client and endpoint configuration is incomplete.",
      );
    }
    return { clientId: this.config.GOOGLE_CLIENT_ID };
  }

  async authenticateWithGoogle({ credential, code, organization }) {
    this.#assertAvailable();
    this.#assertSessionSigningConfigured();
    const identity = await this.googleAuth.authenticate({ credential, code });
    const { email, googleSub, name } = identity;

    let user = await this.repository.findUserByGoogleSub(googleSub);
    if (!user) user = await this.repository.findUserByEmail(email);
    const now = new Date();

    if (user) {
      if (user.googleSub && user.googleSub !== googleSub) {
        throw new AppError(
          409,
          "GOOGLE_IDENTITY_CONFLICT",
          "This email is linked to a different Google account.",
        );
      }
      const changes = {
        googleSub,
        email,
        emailNormalized: email,
        authProvider: "google",
        lastLoginAt: now,
      };
      if (!user.name && name) changes.name = name;
      if (organization?.trim()) changes.organization = organization.trim();
      user = await this.repository.updateUser(user._id, changes);
    } else {
      const newUser = {
        googleSub,
        email,
        emailNormalized: email,
        name: name?.trim() || email.split("@")[0],
        organization: organization?.trim() || "Personal workspace",
        authProvider: "google",
        createdAt: now,
        updatedAt: now,
        lastLoginAt: now,
      };
      try {
        const result = await this.repository.createUser(newUser);
        user = await this.repository.findUserById(result.insertedId);
      } catch (error) {
        if (error.code !== 11000) throw error;
        user =
          (await this.repository.findUserByGoogleSub(googleSub)) ||
          (await this.repository.findUserByEmail(email));
        if (!user) throw error;
      }
    }

    return this.#session(user);
  }

  async getProfile(userId) {
    const user = await this.#getUser(userId);
    return this.#publicUser(user);
  }

  async updateProfile(userId, changes) {
    const cleanChanges = Object.fromEntries(
      Object.entries(changes).map(([key, value]) => [key, value.trim()]),
    );
    const user = await this.repository.updateUser(
      new ObjectId(userId),
      cleanChanges,
    );
    return this.#publicUser(user);
  }

  listEndpoints() {
    return endpointCatalog;
  }

  async createApiKey(userId, { name, scopes }) {
    this.#assertAvailable();
    this.#validateScopes(scopes);
    const secret = `wfmk_live_${randomBytes(32).toString("base64url")}`;
    const now = new Date();
    const key = {
      ownerId: new ObjectId(userId),
      name: name.trim(),
      prefix: secret.slice(0, 16),
      secretHash: this.#hashSecret(secret),
      scopes,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: null,
      revokedAt: null,
    };
    const result = await this.repository.createApiKey(key);
    return {
      id: result.insertedId.toString(),
      name: key.name,
      prefix: key.prefix,
      secret,
      scopes: key.scopes,
      createdAt: now,
    };
  }

  async listApiKeys(userId) {
    this.#assertAvailable();
    const keys = await this.repository.listApiKeys(new ObjectId(userId));
    return keys.map(
      ({ _id, name, prefix, scopes, createdAt, lastUsedAt, revokedAt }) => ({
        id: _id.toString(),
        name,
        prefix,
        scopes,
        createdAt,
        lastUsedAt,
        revokedAt,
      }),
    );
  }

  async updateApiKeyScopes(userId, keyId, scopes) {
    this.#assertAvailable();
    this.#validateScopes(scopes);
    const result = await this.repository.updateApiKeyScopes(
      new ObjectId(userId),
      this.#objectId(keyId),
      scopes,
    );
    if (!result.matchedCount)
      throw new AppError(
        404,
        "API_KEY_NOT_FOUND",
        "The API key was not found.",
      );
    return { id: keyId, scopes };
  }

  async revokeApiKey(userId, keyId) {
    this.#assertAvailable();
    const result = await this.repository.revokeApiKey(
      new ObjectId(userId),
      this.#objectId(keyId),
    );
    if (!result.matchedCount)
      throw new AppError(
        404,
        "API_KEY_NOT_FOUND",
        "The active API key was not found.",
      );
    return { id: keyId, revoked: true };
  }

  async getUsage(userId, days) {
    this.#assertAvailable();
    return this.repository.getUsage(new ObjectId(userId), days);
  }

  async validateApiKey(secret, endpointId) {
    this.#assertAvailable();
    const key = await this.repository.findApiKeyByHash(
      this.#hashSecret(secret),
    );
    if (!key)
      throw new AppError(
        401,
        "INVALID_API_KEY",
        "The API key is invalid or revoked.",
      );
    if (key.expiresAt && key.expiresAt <= new Date()) {
      throw new AppError(401, "API_KEY_EXPIRED", "The API key has expired.");
    }
    if (!key.scopes.includes(endpointId)) {
      throw new AppError(
        403,
        "API_KEY_SCOPE_DENIED",
        "The API key is not enabled for this endpoint.",
      );
    }
    return key;
  }

  async recordUsage(usage) {
    if (!this.repository) return;
    await Promise.all([
      this.repository.recordUsage(usage),
      this.repository.touchApiKey(usage.apiKeyId),
    ]);
  }

  #validateScopes(scopes) {
    if (
      !Array.isArray(scopes) ||
      scopes.length === 0 ||
      scopes.some((scope) => !endpointById.has(scope))
    ) {
      throw new AppError(
        400,
        "INVALID_ENDPOINT_SCOPE",
        "Select one or more valid API endpoints.",
      );
    }
  }

  #objectId(value) {
    if (!ObjectId.isValid(value))
      throw new AppError(400, "INVALID_API_KEY_ID", "API key id is invalid.");
    return new ObjectId(value);
  }

  async #getUser(userId) {
    this.#assertAvailable();
    if (!ObjectId.isValid(userId))
      throw new AppError(
        401,
        "INVALID_SESSION",
        "Developer session is invalid.",
      );
    const user = await this.repository.findUserById(new ObjectId(userId));
    if (!user)
      throw new AppError(
        404,
        "PROFILE_NOT_FOUND",
        "Developer profile was not found.",
      );
    return user;
  }

  async #session(user) {
    const signingKey = this.#assertSessionSigningConfigured();
    const jose = await import("jose");
    const token = await new jose.SignJWT({ userId: user._id.toString() })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(
        this.config.DEVELOPER_JWT_ISSUER || "whyfolio-market-core-developer",
      )
      .setAudience(
        this.config.DEVELOPER_JWT_AUDIENCE || "whyfolio-developer-portal",
      )
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(signingKey);
    return { token, expiresIn: 3600, user: this.#publicUser(user) };
  }

  #assertSessionSigningConfigured() {
    const signingKey = resolveDeveloperSessionKey(this.config);
    if (!signingKey) {
      throw new AppError(
        503,
        "DEVELOPER_AUTH_NOT_CONFIGURED",
        "Developer authentication is not configured.",
      );
    }
    return signingKey;
  }

  #publicUser(user) {
    return {
      id: user._id.toString(),
      email: user.email,
      name: user.name,
      organization: user.organization,
      createdAt: user.createdAt,
    };
  }

  #hashSecret(secret) {
    return createHash("sha256").update(secret).digest("hex");
  }

  #assertAvailable() {
    if (!this.repository || this.repository.isReady === false) {
      throw new AppError(
        503,
        "CONTROL_PLANE_UNAVAILABLE",
        "Developer account storage is not connected.",
      );
    }
  }
}

module.exports = { DeveloperService };