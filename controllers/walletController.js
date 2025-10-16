const Wallet = require('../models/Wallet');
const Transaction = require('../models/Transaction');

// Get wallet balance
exports.getWalletBalance = async (req, res) => {
  try {
    const userId = req.user.id;
    
    let wallet = await Wallet.findOne({ userId });
    
    // Create wallet if it doesn't exist
    if (!wallet) {
      wallet = new Wallet({
        userId,
        balance: 0
      });
      await wallet.save();
    }
    
    res.status(200).json({
      success: true,
      data: {
        balance: wallet.balance
      }
    });
  } catch (error) {
    console.error('Error fetching wallet:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch wallet balance'
    });
  }
};

// Add funds to wallet
exports.addFunds = async (req, res) => {
  try {
    const userId = req.user.id;
    const { amount, paymentId } = req.body;
    
    if (!amount || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Invalid amount'
      });
    }
    
    if (!paymentId) {
      return res.status(400).json({
        success: false,
        message: 'Payment ID is required'
      });
    }
    
    // Find or create wallet
    let wallet = await Wallet.findOne({ userId });
    if (!wallet) {
      wallet = new Wallet({
        userId,
        balance: 0
      });
    }
    
    // Update balance
    wallet.balance += amount;
    await wallet.save();
    
    // Create transaction record
    const transaction = new Transaction({
      userId,
      type: 'credit',
      amount,
      description: 'Added funds to wallet',
      reference: {
        type: 'payment',
        id: paymentId
      },
      status: 'completed'
    });
    
    await transaction.save();
    
    res.status(200).json({
      success: true,
      data: {
        balance: wallet.balance,
        transaction: transaction
      }
    });
  } catch (error) {
    console.error('Error adding funds:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to add funds to wallet'
    });
  }
};

// Get transaction history
exports.getTransactions = async (req, res) => {
  try {
    const userId = req.user.id;
    const { limit = 10, page = 1 } = req.query;
    
    const skip = (page - 1) * limit;
    
    const transactions = await Transaction.find({ userId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));
    
    const total = await Transaction.countDocuments({ userId });
    
    res.status(200).json({
      success: true,
      data: {
        transactions,
        pagination: {
          total,
          page: parseInt(page),
          limit: parseInt(limit),
          pages: Math.ceil(total / limit)
        }
      }
    });
  } catch (error) {
    console.error('Error fetching transactions:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch transaction history'
    });
  }
};