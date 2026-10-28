const mongoose = require("mongoose");

const developerApiKeySchema = new mongoose.Schema(
  {
    ownerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "DeveloperUser",
      required: true,
    },
    name: { type: String, required: true },
    prefix: { type: String, required: true },
    secretHash: { type: String, required: true, unique: true },
    scopes: { type: [String], required: true },
    lastUsedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null },
  },
  { collection: "developerApiKeys", timestamps: true },
);

developerApiKeySchema.index({ ownerId: 1, createdAt: -1 });

module.exports =
  mongoose.models.DeveloperApiKey ||
  mongoose.model("DeveloperApiKey", developerApiKeySchema);
