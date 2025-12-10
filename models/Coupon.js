const mongoose = require('mongoose');

const couponSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true, trim: true },
    type: { type: String, enum: ['percent', 'fixed'], required: true },
    value: { type: Number, required: true },
    maxRedemptions: { type: Number, default: 100 },
    redemptions: { type: Number, default: 0 },
    perUserLimit: { type: Number, default: 1 },
    applicableTo: { type: [String], default: ['subscription', 'group', 'note'] },
    minAmount: { type: Number, default: 0 },
    validFrom: { type: Date, default: null },
    validTo: { type: Date, default: null },
    status: { type: String, enum: ['active', 'paused'], default: 'active' },
    campaign: { type: String, default: null },
  },
  { timestamps: true }
);

couponSchema.index({ code: 1 }, { unique: true });

module.exports = mongoose.models.Coupon || mongoose.model('Coupon', couponSchema);

