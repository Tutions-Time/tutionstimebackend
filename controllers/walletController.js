const walletService = require('../services/payments/walletService');

exports.getMyWallet = async (req, res) => {
  try {
    if (req.user?.role === 'admin') {
      const adminWallet = await walletService.getAdminWallet();
      return res.status(200).json({ success: true, data: adminWallet });
    }
    const wallet = await walletService.getWallet(req.user.id);
    res.status(200).json({ success: true, data: wallet });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.getMyTransactions = async (req, res) => {
  try {
    const Transaction = require('../models/Transaction');
    const { type, page = 1, limit = 50 } = req.query;
    const filter = { userId: req.user.id };
    if (type) filter['reference.type'] = type;
    const skip = Math.max(0, (Number(page) - 1) * Number(limit));
    const items = await Transaction.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit));
    res.status(200).json({ success: true, data: items });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
