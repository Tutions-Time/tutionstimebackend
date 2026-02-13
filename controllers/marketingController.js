const ReferralCode = require('../models/ReferralCode');
const ReferralUse = require('../models/ReferralUse');
const Coupon = require('../models/Coupon');
const CouponUse = require('../models/CouponUse');
const User = require('../models/User');
const ReferralSettings = require('../models/ReferralSettings');

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

exports.testGrantReferral = async (req, res) => {
  try {
    const { studentUserId } = req.body;
    if (!studentUserId) return res.status(400).json({ success: false, message: 'studentUserId required' });
    const User = require('../models/User');
    const ReferralCode = require('../models/ReferralCode');
    const ReferralUse = require('../models/ReferralUse');
    const walletService = require('../services/payments/walletService');
    const settings = await ReferralSettings.findOne();
    const user = await User.findById(studentUserId);
    if (!user || !user.referrerUserId) return res.status(404).json({ success: false, message: 'No referrer recorded' });
    if (user.referralRewardGranted) return res.json({ success: true, message: 'Already granted' });
    const referrer = await User.findById(user.referrerUserId).select('role');
    const defaultStudent = 100;
    const defaultTutor = 100;
    const rewardAmount = (referrer?.role === 'tutor' ? (settings?.tutorRewardAmount ?? defaultTutor) : (settings?.studentRewardAmount ?? defaultStudent));
    const rc = user.referralCodeUsed ? await ReferralCode.findOne({ code: user.referralCodeUsed }) : null;
    if (rc && rc.maxUses && rc.usedCount >= rc.maxUses) return res.status(400).json({ success: false, message: 'Referral code usage limit reached' });
    const refRole = referrer?.role === 'student' ? 'student' : 'tutor';
    const aw1 = await walletService.getAdminWallet();
    if ((aw1?.balance || 0) < rewardAmount) {
      await walletService.adminCredit(rewardAmount, 'Referral fund top-up', { type: 'referral', id: null });
    }
    await walletService.adminDebit(rewardAmount, 'Referral reward', { type: 'referral', id: null });
    await walletService.creditWallet(user.referrerUserId, refRole, rewardAmount, 'Referral reward', { type: 'referral', id: null });
    const bonus = settings?.referredUserBonusAmount ?? 0;
    if (bonus > 0) {
      const aw2 = await walletService.getAdminWallet();
      if ((aw2?.balance || 0) < bonus) {
        await walletService.adminCredit(bonus, 'Referral fund top-up', { type: 'referral', id: null });
      }
      await walletService.adminDebit(bonus, 'Referral signup bonus', { type: 'referral', id: null });
      await walletService.creditWallet(user._id, 'student', bonus, 'Referral signup bonus', { type: 'referral', id: null });
    }
    if (rc) {
      await ReferralUse.create({ referralCodeId: rc._id, referrerUserId: user.referrerUserId, referredUserId: user._id, paymentId: null, rewardGranted: true, amountGranted: rewardAmount });
      rc.usedCount = (rc.usedCount || 0) + 1;
      await rc.save();
    }
    user.referralRewardGranted = true;
    await user.save();
    const adminWallet = await walletService.getAdminWallet();
    const refWallet = await walletService.getWallet(user.referrerUserId);
    const stuWallet = await walletService.getWallet(user._id);
    try {
      const notificationService = require('../services/notificationService');
      await notificationService.notifyUser(
        user.referrerUserId,
        'Referral Reward Granted',
        'A referral reward was credited',
        { amountGranted: rewardAmount }
      );
      if (bonus > 0) {
        await notificationService.notifyUser(
          user._id,
          'Referral Bonus Applied',
          'A signup bonus was credited',
          { bonusAmount: bonus }
        );
      }
    } catch (_) {}
    try {
      const { createAdminNotification } = require('../services/adminNotification');
      void createAdminNotification(
        "Referral Reward Granted",
        `Referral reward of ${rewardAmount} granted to ${user.referrerUserId}. Signup bonus of ${bonus} granted to student ${user._id}.`,
        {
          referrerUserId: user.referrerUserId,
          studentUserId: user._id,
          rewardAmount,
          bonusAmount: bonus
        }
      );
    } catch (_) {}

    res.json({ success: true, data: { adminWallet, refWallet, stuWallet, rewardAmount, bonus } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error', error: err.message });
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
    // Optional role applicability check
    if (Array.isArray(rc.allowedRoles) && rc.allowedRoles.length && !rc.allowedRoles.includes(user.role)) {
      return res.status(400).json({ success: false, message: 'Referral code not applicable for this role' });
    }
    user.referrerUserId = rc.ownerUserId;
    user.referralCodeUsed = referralCode;
    await user.save();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// Get referral settings (admin)
exports.getReferralSettings = async (_req, res) => {
  try {
    const settings = await ReferralSettings.findOne().lean();
    if (!settings) {
      return res.json({ success: true, data: { studentRewardAmount: 100, tutorRewardAmount: 100, status: 'active' } });
    }
    const { studentRewardAmount, tutorRewardAmount, status } = settings;
    res.json({ success: true, data: { studentRewardAmount, tutorRewardAmount, status } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// Update referral settings (admin)
exports.updateReferralSettings = async (req, res) => {
  try {
    const { studentRewardAmount, tutorRewardAmount, status } = req.body;
    const settings = await ReferralSettings.findOneAndUpdate(
      {},
      {
        $set: {
          ...(studentRewardAmount !== undefined ? { studentRewardAmount } : {}),
          ...(tutorRewardAmount !== undefined ? { tutorRewardAmount } : {}),
          ...(status ? { status } : {}),
        },
      },
      { upsert: true, new: true }
    );
    const { studentRewardAmount: sr, tutorRewardAmount: tr, status: st } = settings;
    res.json({ success: true, data: { studentRewardAmount: sr, tutorRewardAmount: tr, status: st } });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};

exports.applyReferralSettingsToCodes = async (_req, res) => {
  try {
    const settings = await ReferralSettings.findOne().lean();
    const tutorAmount = settings?.tutorRewardAmount ?? 100;
    const studentAmount = settings?.studentRewardAmount ?? 100;
    const tutorIds = await User.find({ role: 'tutor' }).select('_id').lean();
    const studentIds = await User.find({ role: 'student' }).select('_id').lean();
    const tIds = tutorIds.map((x) => x._id);
    const sIds = studentIds.map((x) => x._id);
    await ReferralCode.updateMany({ ownerUserId: { $in: tIds } }, { $set: { rewardType: 'fixed', rewardAmount: tutorAmount } });
    await ReferralCode.updateMany({ ownerUserId: { $in: sIds } }, { $set: { rewardType: 'fixed', rewardAmount: studentAmount } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

exports.applyReferralSettingsToStudentCodes = async (_req, res) => {
  try {
    const settings = await ReferralSettings.findOne().lean();
    const amount = settings?.studentRewardAmount ?? 100;
    const studentIds = await User.find({ role: 'student' }).select('_id').lean();
    const sIds = studentIds.map((x) => x._id);
    await ReferralCode.updateMany({ ownerUserId: { $in: sIds } }, { $set: { rewardType: 'fixed', rewardAmount: amount } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

exports.applyReferralSettingsToTutorCodes = async (_req, res) => {
  try {
    const settings = await ReferralSettings.findOne().lean();
    const amount = settings?.tutorRewardAmount ?? 100;
    const tutorIds = await User.find({ role: 'tutor' }).select('_id').lean();
    const tIds = tutorIds.map((x) => x._id);
    await ReferralCode.updateMany({ ownerUserId: { $in: tIds } }, { $set: { rewardType: 'fixed', rewardAmount: amount } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

