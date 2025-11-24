const mongoose = require("mongoose");

const adminWalletSchema = new mongoose.Schema(
  {
    balance: { type: Number, default: 0 },
    holdAmount: { type: Number, default: 0 },
    currency: { type: String, default: "INR" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("AdminWallet", adminWalletSchema);
