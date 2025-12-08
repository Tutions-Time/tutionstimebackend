const ReferralCode = require('../models/ReferralCode');
const ReferralUse = require('../models/ReferralUse');
const Coupon = require('../models/Coupon');
const CouponUse = require('../models/CouponUse');
const User = require('../models/User');

exports.createReferralCode = async (req, res) => {
  try {
    const { code, rewardType, rewardAmount, maxUses, expiry, allowedRoles, campaign } = req.body;
    const ownerUserId = req.body.ownerUserId || req.user.id;
    const rc = await ReferralCode.create({ code, ownerUserId, rewardType, rewardAmount, maxUses, expiry, allowedRoles, campaign });
    res.json({ success: true, data: rc });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};

exports.listReferralCodes = async (req, res) => {
  const list = await ReferralCode.find().sort({ createdAt: -1 }).lean();
  res.json({ success: true, data: list });
};

exports.updateReferralCode = async (req, res) => {
  try {
    const rc = await ReferralCode.findByIdAndUpdate(req.params.id, req.body, { new: true });
    res.json({ success: true, data: rc });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};

exports.createCoupon = async (req, res) => {
  try {
    const { code, type, value, maxRedemptions, perUserLimit, applicableTo, minAmount, validFrom, validTo, status, campaign } = req.body;
    const c = await Coupon.create({ code, type, value, maxRedemptions, perUserLimit, applicableTo, minAmount, validFrom, validTo, status, campaign });
    res.json({ success: true, data: c });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};

exports.listCoupons = async (_, res) => {
  const list = await Coupon.find().sort({ createdAt: -1 }).lean();
  res.json({ success: true, data: list });
};

exports.updateCoupon = async (req, res) => {
  try {
    const c = await Coupon.findByIdAndUpdate(req.params.id, req.body, { new: true });
    res.json({ success: true, data: c });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};

exports.validateCoupon = async (req, res) => {
  try {
    const { code, type, amount } = req.body; // type: subscription|group|note
    const c = await Coupon.findOne({ code });
    if (!c || c.status !== 'active') return res.status(404).json({ success: false, message: 'Invalid coupon' });
    const now = new Date();
    if ((c.validFrom && now < c.validFrom) || (c.validTo && now > c.validTo)) return res.status(400).json({ success: false, message: 'Coupon expired' });
    if (!c.applicableTo.includes(type)) return res.status(400).json({ success: false, message: 'Not applicable' });
    if (amount < c.minAmount) return res.status(400).json({ success: false, message: 'Amount below minimum' });
    const discount = c.type === 'percent' ? Math.floor((amount * c.value) / 100) : Math.min(c.value, amount);
    return res.json({ success: true, data: { discount, finalAmount: amount - discount } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

exports.applyReferralOnSignup = async (req, res) => {
  try {
    const { phone, referralCode } = req.body;
    if (!referralCode) return res.json({ success: true, message: 'No referral code provided' });
    const rc = await ReferralCode.findOne({ code: referralCode });
    if (!rc || rc.status !== 'active') return res.status(404).json({ success: false, message: 'Invalid referral code' });
    const user = await User.findOne({ phone });
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    user.referrerUserId = rc.ownerUserId;
    user.referralCodeUsed = referralCode;
    await user.save();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

