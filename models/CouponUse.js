const mongoose = require('mongoose');

const couponUseSchema = new mongoose.Schema(
  {
    couponId: { type: mongoose.Schema.Types.ObjectId, ref: 'Coupon', required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    paymentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Payment' },
    amountDiscounted: { type: Number, default: 0 },
    usedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

couponUseSchema.index({ couponId: 1, userId: 1 }, { unique: false });

module.exports = mongoose.models.CouponUse || mongoose.model('CouponUse', couponUseSchema);

