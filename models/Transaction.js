const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  type: {
    type: String,
    enum: ['credit', 'debit'],
    required: true
  },
  amount: {
    type: Number,
    required: true,
    min: 0
  },
  description: {
    type: String,
    required: true
  },
  reference: {
    type: {
      type: String,
      enum: ['booking', 'payout', 'refund']
    },
    id: {
      type: mongoose.Schema.Types.ObjectId
    }
  },
  regularClassId: { type: mongoose.Schema.Types.ObjectId, ref: 'RegularClass' },
  paymentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Payment' },
  status: {
    type: String,
    enum: ['pending', 'completed', 'failed', 'locked'],
    default: 'pending'
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('Transaction', transactionSchema);
