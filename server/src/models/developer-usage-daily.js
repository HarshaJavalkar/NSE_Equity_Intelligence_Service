const mongoose = require("mongoose");

const developerUsageDailySchema = new mongoose.Schema(
  {
    ownerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "DeveloperUser",
      required: true,
    },
    apiKeyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "DeveloperApiKey",
      required: true,
    },
    endpointId: { type: String, required: true },
    date: { type: String, required: true },
    requestCount: { type: Number, default: 0 },
    successCount: { type: Number, default: 0 },
    clientErrorCount: { type: Number, default: 0 },
    serverErrorCount: { type: Number, default: 0 },
    lastUsedAt: { type: Date, required: true },
  },
  { collection: "developerUsageDaily" },
);

developerUsageDailySchema.index(
  { ownerId: 1, apiKeyId: 1, endpointId: 1, date: 1 },
  { unique: true },
);

module.exports =
  mongoose.models.DeveloperUsageDaily ||
  mongoose.model("DeveloperUsageDaily", developerUsageDailySchema);
