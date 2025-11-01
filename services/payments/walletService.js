// services/payments/walletService.js
const Wallet = require("../../models/Wallet");
const Transaction = require("../../models/Transaction");

// Ensure wallet exists (auto-create if not)
exports.ensureWallet = async (userId, role) => {
  let wallet = await Wallet.findOne({ userId });
  if (!wallet) {
    wallet = await Wallet.create({ userId, role, balance: 0 });
    // console.log(`🪙 Wallet created for ${role} (${userId})`);
  }
  return wallet;
};

// Credit wallet (add funds)
exports.creditWallet = async (userId, role, amount, description, referenceId) => {
  const wallet = await this.ensureWallet(userId, role);
  wallet.balance += amount;
  await wallet.save();

  await Transaction.create({
    userId,
    type: "credit",
    amount,
    description,
    reference: { type: "booking", id: referenceId },
    status: "completed",
  });

  return wallet;
};

// Debit wallet (remove funds)
exports.debitWallet = async (userId, role, amount, description, referenceId) => {
  const wallet = await this.ensureWallet(userId, role);
  if (wallet.balance < amount) throw new Error("Insufficient balance");
  wallet.balance -= amount;
  await wallet.save();

  await Transaction.create({
    userId,
    type: "debit",
    amount,
    description,
    reference: { type: "booking", id: referenceId },
    status: "completed",
  });

  return wallet;
};

// Fetch wallet by user
exports.getWallet = async (userId) => {
  const wallet = await Wallet.findOne({ userId });
  return wallet || { balance: 0 };
};
