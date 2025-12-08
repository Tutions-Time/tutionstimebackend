const mongoose = require('mongoose');

const referralUseSchema = new mongoose.Schema(
  {
    referralCodeId: { type: mongoose.Schema.Types.ObjectId, ref: 'ReferralCode', required: true },
    referrerUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    referredUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    paymentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Payment' },
    rewardGranted: { type: Boolean, default: false },
    amountGranted: { type: Number, default: 0 },
    usedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

referralUseSchema.index({ referralCodeId: 1, referredUserId: 1 }, { unique: true });

module.exports = mongoose.models.ReferralUse || mongoose.model('ReferralUse', referralUseSchema);

