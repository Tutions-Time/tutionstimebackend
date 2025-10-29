const Wallet = require('../../models/Wallet');
const Transaction = require('../../models/Transaction');

exports.creditWallet = async (userId, role, amount, description, referenceId) => {
  const wallet = await Wallet.findOneAndUpdate(
    { userId },
    { $inc: { balance: amount }, $setOnInsert: { role } },
    { new: true, upsert: true }
  );

  await Transaction.create({
    userId,
    type: 'credit',
    amount,
    description,
    referenceId,
    balanceAfter: wallet.balance
  });

  return wallet;
};

exports.debitWallet = async (userId, amount, description, referenceId) => {
  const wallet = await Wallet.findOne({ userId });
  if (!wallet || wallet.balance < amount) throw new Error('Insufficient balance');

  wallet.balance -= amount;
  await wallet.save();

  await Transaction.create({
    userId,
    type: 'debit',
    amount,
    description,
    referenceId,
    balanceAfter: wallet.balance
  });

  return wallet;
};

exports.getWallet = async (userId) => {
  const wallet = await Wallet.findOne({ userId });
  return wallet || { balance: 0 };
};
