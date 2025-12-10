const mongoose = require('mongoose');

const referralSettingsSchema = new mongoose.Schema(
  {
    studentRewardAmount: { type: Number, default: 100 },
    tutorRewardAmount: { type: Number, default: 100 },
    referredUserBonusAmount: { type: Number, default: 0 },
    status: { type: String, enum: ['active', 'paused'], default: 'active' },
  },
  { timestamps: true }
);

module.exports = mongoose.models.ReferralSettings || mongoose.model('ReferralSettings', referralSettingsSchema);

