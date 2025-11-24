const Wallet = require("../../models/Wallet");
const Transaction = require("../../models/Transaction");
const AdminWallet = require("../../models/AdminWallet");

exports.ensureWallet = async (userId, role) => {
  let wallet = await Wallet.findOne({ userId });
  if (!wallet) {
    wallet = await Wallet.create({ userId, role, balance: 0, pendingBalance: 0 });
    // console.log(`🪙 Wallet created for ${role} (${userId})`);
  }
  return wallet;
};

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

exports.getWallet = async (userId) => {
  const wallet = await Wallet.findOne({ userId });
  return wallet || { balance: 0 };
};

async function ensureAdminWallet() {
  let aw = await AdminWallet.findOne();
  if (!aw) aw = await AdminWallet.create({ balance: 0, holdAmount: 0, currency: "INR" });
  return aw;
}

exports.getAdminWallet = async () => {
  const aw = await ensureAdminWallet();
  return aw;
};

exports.adminCredit = async (amount, description, reference) => {
  const aw = await ensureAdminWallet();
  aw.balance += amount;
  await aw.save();
  return aw;
};

exports.adminDebit = async (amount, description, reference) => {
  const aw = await ensureAdminWallet();
  if (aw.balance < amount) throw new Error("Admin balance insufficient");
  aw.balance -= amount;
  await aw.save();
  return aw;
};

exports.adminIncreaseHold = async (amount) => {
  const aw = await ensureAdminWallet();
  aw.holdAmount += amount;
  await aw.save();
  return aw;
};

exports.adminDecreaseHold = async (amount) => {
  const aw = await ensureAdminWallet();
  aw.holdAmount = Math.max(0, aw.holdAmount - amount);
  await aw.save();
  return aw;
};

exports.creditPending = async (userId, role, amount, description, reference) => {
  const wallet = await this.ensureWallet(userId, role);
  wallet.pendingBalance += amount;
  await wallet.save();

  await Transaction.create({
    userId,
    type: "credit",
    amount,
    description,
    reference,
    status: "locked",
  });

  return wallet;
};

exports.releasePendingToAvailable = async (userId, role, amount, description, reference) => {
  const wallet = await this.ensureWallet(userId, role);
  if (wallet.pendingBalance < amount) throw new Error("Pending balance insufficient");
  wallet.pendingBalance -= amount;
  wallet.balance += amount;
  await wallet.save();

  await Transaction.create({
    userId,
    type: "credit",
    amount,
    description,
    reference,
    status: "completed",
  });

  return wallet;
};

exports.addTransaction = async ({ userId, type, amount, description, reference, status, regularClassId, paymentId }) => {
  return Transaction.create({ userId, type, amount, description, reference, status, regularClassId, paymentId });
};
