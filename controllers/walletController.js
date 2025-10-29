const walletService = require('../services/payments/walletService');

exports.getMyWallet = async (req, res) => {
  try {
    const wallet = await walletService.getWallet(req.user.id);
    res.status(200).json({ success: true, data: wallet });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.getMyTransactions = async (req, res) => {
  try {
    const Transaction = require('../models/Transaction');
    const transactions = await Transaction.find({ userId: req.user.id }).sort({ createdAt: -1 });
    res.status(200).json({ success: true, data: transactions });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
