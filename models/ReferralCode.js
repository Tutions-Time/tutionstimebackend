const mongoose = require('mongoose');

const referralCodeSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true, trim: true },
    ownerUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    rewardType: { type: String, enum: ['fixed', 'percent'], default: 'fixed' },
    rewardAmount: { type: Number, default: 100 },
    maxUses: { type: Number, default: 100 },
    usedCount: { type: Number, default: 0 },
    expiry: { type: Date, default: null },
    allowedRoles: { type: [String], default: ['student'] },
    status: { type: String, enum: ['active', 'paused'], default: 'active' },
    campaign: { type: String, default: null },
  },
  { timestamps: true }
);

referralCodeSchema.index({ code: 1 }, { unique: true });

module.exports = mongoose.models.ReferralCode || mongoose.model('ReferralCode', referralCodeSchema);

