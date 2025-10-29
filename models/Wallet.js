const mongoose = require('mongoose');

const walletSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type: { type: String, enum: ['credit', 'debit'], required: true },
  amount: { type: Number, required: true },
  description: { type: String },
  referenceId: { type: String }, 
  status: { type: String, enum: ['success', 'failed', 'pending'], default: 'success' },
  balanceAfter: { type: Number },
}, { timestamps: true });

module.exports = mongoose.model('Wallet', walletSchema);
