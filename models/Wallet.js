// models/Wallet.js
const mongoose = require("mongoose");

const walletSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, unique: true },
    role: { type: String, enum: ["student", "tutor"], required: true },
    balance: { type: Number, default: 0 },
    pendingBalance: { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Wallet", walletSchema);
