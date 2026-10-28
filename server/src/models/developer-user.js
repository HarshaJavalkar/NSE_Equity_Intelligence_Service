const mongoose = require("mongoose");

const developerUserSchema = new mongoose.Schema(
  {
    googleSub: { type: String, sparse: true, unique: true },
    email: { type: String, required: true },
    emailNormalized: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    organization: { type: String, required: true },
    authProvider: { type: String, enum: ["google"], required: true },
    lastLoginAt: { type: Date, required: true },
  },
  { collection: "developerUsers", timestamps: true },
);

module.exports =
  mongoose.models.DeveloperUser ||
  mongoose.model("DeveloperUser", developerUserSchema);
