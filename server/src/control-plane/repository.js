const DeveloperUser = require("../models/developer-user");
const DeveloperApiKey = require("../models/developer-api-key");
const DeveloperUsageDaily = require("../models/developer-usage-daily");

class ControlPlaneRepository {
  constructor() {
    this.isReady = false;
  }

  async initialize() {
    await Promise.all([
      DeveloperUser.createIndexes(),
      DeveloperApiKey.createIndexes(),
      DeveloperUsageDaily.createIndexes(),
    ]);
    this.isReady = true;
  }

  async createUser(user) {
    const created = await DeveloperUser.create(user);
    return { insertedId: created._id };
  }

  findUserByEmail(emailNormalized) {
    return DeveloperUser.findOne({ emailNormalized }).exec();
  }

  findUserByGoogleSub(googleSub) {
    return DeveloperUser.findOne({ googleSub }).exec();
  }

  findUserById(userId) {
    return DeveloperUser.findById(userId).exec();
  }

  updateUser(userId, changes) {
    return DeveloperUser.findByIdAndUpdate(userId, changes, {
      new: true,
      runValidators: true,
    }).exec();
  }

  async createApiKey(apiKey) {
    const created = await DeveloperApiKey.create(apiKey);
    return { insertedId: created._id };
  }

  listApiKeys(ownerId) {
    return DeveloperApiKey.find({ ownerId })
      .sort({ createdAt: -1 })
      .lean()
      .exec();
  }

  findApiKeyByHash(secretHash) {
    return DeveloperApiKey.findOne({ secretHash, revokedAt: null })
      .lean()
      .exec();
  }

  updateApiKeyScopes(ownerId, keyId, scopes) {
    return DeveloperApiKey.updateOne(
      { _id: keyId, ownerId, revokedAt: null },
      { $set: { scopes } },
      { runValidators: true },
    ).exec();
  }

  revokeApiKey(ownerId, keyId) {
    return DeveloperApiKey.updateOne(
      { _id: keyId, ownerId, revokedAt: null },
      { $set: { revokedAt: new Date() } },
    ).exec();
  }

  touchApiKey(keyId) {
    return DeveloperApiKey.updateOne(
      { _id: keyId, revokedAt: null },
      { $set: { lastUsedAt: new Date() } },
    ).exec();
  }

  recordUsage({ ownerId, apiKeyId, endpointId, statusCode }) {
    const now = new Date();
    const date = now.toISOString().slice(0, 10);
    return DeveloperUsageDaily.updateOne(
      { ownerId, apiKeyId, endpointId, date },
      {
        $inc: {
          requestCount: 1,
          successCount: statusCode < 400 ? 1 : 0,
          clientErrorCount: statusCode >= 400 && statusCode < 500 ? 1 : 0,
          serverErrorCount: statusCode >= 500 ? 1 : 0,
        },
        $set: { lastUsedAt: now },
      },
      { upsert: true },
    ).exec();
  }

  async getUsage(ownerId, days) {
    const since = new Date();
    since.setUTCDate(since.getUTCDate() - days + 1);
    const sinceDate = since.toISOString().slice(0, 10);
    return DeveloperUsageDaily.aggregate([
      { $match: { ownerId, date: { $gte: sinceDate } } },
      {
        $group: {
          _id: { date: "$date", endpointId: "$endpointId" },
          requests: { $sum: "$requestCount" },
          successes: { $sum: "$successCount" },
          clientErrors: { $sum: "$clientErrorCount" },
          serverErrors: { $sum: "$serverErrorCount" },
        },
      },
      { $sort: { "_id.date": -1 } },
      {
        $project: {
          _id: 0,
          date: "$_id.date",
          endpointId: "$_id.endpointId",
          requests: 1,
          successes: 1,
          clientErrors: 1,
          serverErrors: 1,
        },
      },
    ]).exec();
  }
}

module.exports = { ControlPlaneRepository };
