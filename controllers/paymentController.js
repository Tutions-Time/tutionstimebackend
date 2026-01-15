const crypto = require("crypto");
const razorpay = require("../services/payments/razorpay"); 
const Payment = require("../models/Payment");
const RegularClass = require("../models/RegularClass");
const TutorProfile = require("../models/TutorProfile");
const Note = require("../models/Note");
const { createAdminNotification } = require("../services/adminNotification");
const walletService = require("../services/payments/walletService");
const { default: mongoose } = require("mongoose");
const GroupBatch = require("../models/GroupBatch");
const Coupon = require("../models/Coupon");
const CouponUse = require("../models/CouponUse");
const ReferralCode = require("../models/ReferralCode");
const ReferralUse = require("../models/ReferralUse");
const Session = require("../models/Session");

const HOLD_DAYS = Number(process.env.TUTOR_FUND_HOLD_DAYS || 30);
const HOLD_MS = HOLD_DAYS * 24 * 60 * 60 * 1000;

function computeReleaseDate(baseDate = new Date()) {
  return new Date(baseDate.getTime() + HOLD_MS);
}

function scheduleFundRelease(payment, baseDate = new Date()) {
  const releaseDate = computeReleaseDate(baseDate);
  payment.releaseAt = releaseDate;
  payment.fundReleaseDate = releaseDate;
  payment.fundReleaseStatus = "pending";
  payment.fundReleasedAt = null;
}

async function applyCouponIfValid({ code, type, amount, userId }) {
  if (!code) return { discount: 0, coupon: null };
  const c = await Coupon.findOne({ code });
  if (!c || c.status !== "active") return { discount: 0, coupon: null };
  const now = new Date();
  if ((c.validFrom && now < c.validFrom) || (c.validTo && now > c.validTo)) return { discount: 0, coupon: null };
  if (!c.applicableTo.includes(type)) return { discount: 0, coupon: null };
  if (amount < c.minAmount) return { discount: 0, coupon: null };
  const priorUses = await CouponUse.countDocuments({ couponId: c._id, userId });
  if (priorUses >= (c.perUserLimit || 1)) return { discount: 0, coupon: null };
  if ((c.redemptions || 0) >= (c.maxRedemptions || 0)) return { discount: 0, coupon: null };
  const discount = c.type === "percent" ? Math.floor((amount * c.value) / 100) : Math.min(c.value, amount);
  return { discount, coupon: c };
}

async function computeRefundCap(payment) {
  try {
    const ctx = await getRefundContext(payment._id);
    return Math.max(0, Number(ctx.refundableCap || 0));
  } catch (_) {
    return Math.max(0, Number(payment.amount || 0));
  }
}

async function recordCouponUse({ coupon, userId, paymentId, amountDiscounted }) {
  if (!coupon) return;
  await CouponUse.create({ couponId: coupon._id, userId, paymentId, amountDiscounted });
  coupon.redemptions = (coupon.redemptions || 0) + 1;
  await coupon.save();
}

async function getRefundContext(paymentId) {
  const p = await Payment.findById(paymentId).lean();
  if (!p) return { totalPaid: 0, completionPercentage: 0, refundablePercentage: 0, refundableCap: 0, alreadyRefunded: 0, remainingRefundable: 0, refundWindowValid: false, payoutState: "locked" };
  const totalPaid = Number(p.amount || 0);
  const alreadyRefunded = Math.max(0, Number(p.refundTotal || 0));
  const now = new Date();
  const refundWindowValid = p.createdAt ? ((now.getTime() - new Date(p.createdAt).getTime()) <= 30 * 24 * 60 * 60 * 1000) : false;
  let completionPercentage = 0;
  let totalUnits = 0;
  let completedUnits = 0;
  if (p.type === "subscription" && p.regularClassId) {
    const rc = await RegularClass.findById(p.regularClassId).lean();
    if (rc) {
      if (rc.planType === "hourly") {
        totalUnits = Math.max(0, Number(rc.classCount || 0));
        completedUnits = await Session.countDocuments({ regularClassId: rc._id, status: "completed" });
      } else {
        const ps = p.periodStart || rc.currentPeriodStart || null;
        const pe = p.periodEnd || rc.currentPeriodEnd || null;
        const range = ps && pe ? { startDateTime: { $gte: ps, $lte: pe } } : {};
        totalUnits = await Session.countDocuments({ regularClassId: rc._id, ...range });
        completedUnits = await Session.countDocuments({ regularClassId: rc._id, status: "completed", ...range });
      }
    }
  } else if (p.type === "group" && p.groupBatchId) {
    totalUnits = await Session.countDocuments({ groupBatchId: p.groupBatchId });
    completedUnits = await Session.countDocuments({ groupBatchId: p.groupBatchId, status: "completed" });
  } else {
    totalUnits = 1;
    completedUnits = 0;
  }
  if (totalUnits > 0) {
    completionPercentage = Math.min(1, Math.max(0, Number(completedUnits || 0) / Number(totalUnits || 1)));
  } else {
    completionPercentage = 0;
  }
  let refundablePercentage = 0;
  if (completionPercentage === 0) {
    refundablePercentage = 1.0;
  } else if (completionPercentage > 0 && completionPercentage <= 0.25) {
    refundablePercentage = 0.75;
  } else if (completionPercentage > 0.25 && completionPercentage <= 0.5) {
    refundablePercentage = 0.5;
  } else if (completionPercentage > 0.5 && completionPercentage <= 0.75) {
    refundablePercentage = 0.25;
  } else {
    refundablePercentage = 0;
  }
  const refundableCapRaw = Math.max(0, Math.floor(totalPaid * refundablePercentage));
  const refundableCap = refundableCapRaw;
  const remainingRefundable = Math.max(0, refundableCap - alreadyRefunded);
  let payoutState = "locked";
  if (p.type === "subscription" && p.regularClassId) {
    const filter = { type: "payout", regularClassId: p.regularClassId, status: "settled" };
    if (p.periodStart) filter.periodStart = p.periodStart;
    if (p.periodEnd) filter.periodEnd = p.periodEnd;
    const settled = await Payment.findOne(filter).lean();
    payoutState = settled ? "released" : "locked";
  }
  return { totalPaid, completionPercentage, refundablePercentage, refundableCap, alreadyRefunded, remainingRefundable, refundWindowValid, payoutState, payment: p };
}

function applyReasonModifier(ctx, reasonCode) {
  let percent = ctx.refundablePercentage;
  const p = ctx.payment;
  if (reasonCode === "CLASS_NOT_CONDUCTED") {
    percent = 1.0;
  } else if (reasonCode === "TUTOR_ABSENT_OR_LATE") {
    percent = Math.max(percent, 0.75);
  } else if (reasonCode === "WRONG_PURCHASE") {
    const within24h = p.createdAt ? ((new Date().getTime() - new Date(p.createdAt).getTime()) <= 24 * 60 * 60 * 1000) : false;
    percent = within24h ? 1.0 : percent;
  } else if (reasonCode === "QUALITY_ISSUE") {
    percent = percent;
  } else if (reasonCode === "TECHNICAL_ISSUE") {
    percent = percent;
  } else if (reasonCode === "SCHEDULE_CONFLICT") {
    percent = percent;
  } else if (reasonCode === "CONTENT_NOT_AS_DESCRIBED") {
    percent = percent;
  } else if (reasonCode === "OTHER") {
    percent = percent;
  }
  const cap = Math.max(0, Math.floor(Number(ctx.totalPaid || 0) * percent));
  const remaining = Math.max(0, cap - Number(ctx.alreadyRefunded || 0));
  return { ...ctx, refundablePercentage: percent, refundableCap: cap, remainingRefundable: remaining };
}

async function grantReferralIfEligible({ studentUserId, paymentId, amount }) {
  // Entry: attempt referral grant for the given student and payment context
  console.log("getreffer", studentUserId, paymentId, amount);
  try {
    // Resolve user (supports both User._id and StudentProfile._id inputs)
    const User = require("../models/User");
    const ReferralSettings = require("../models/ReferralSettings");
    let user = await User.findById(studentUserId);
    if (!user) {
      const StudentProfile = require("../models/StudentProfile");
      const sp = await StudentProfile.findById(studentUserId).select("userId");
      if (sp?.userId) {
        user = await User.findById(sp.userId);
      }
    }
    // Guard: must have a linked referrer
    if (!user || !user.referrerUserId) { console.log("referral:skip-no-user-or-referrer", { userPresent: !!user, referrer: user?.referrerUserId }); return; }
    // Load referral code and referrer role for reward computation
    const rc = user.referralCodeUsed ? await ReferralCode.findOne({ code: user.referralCodeUsed }) : null;
    const referrer = await User.findById(user.referrerUserId).select("role");
    const settings = await ReferralSettings.findOne();
    const defaultStudent = 100;
    const defaultTutor = 100;
    const rewardAmount = (referrer?.role === "tutor"
      ? (settings?.tutorRewardAmount ?? defaultTutor)
      : (settings?.studentRewardAmount ?? defaultStudent));
    // Guard: respect code max usage
    if (rc && rc.maxUses && rc.usedCount >= rc.maxUses) { console.log("referral:skip-code-limit", { code: rc.code, usedCount: rc.usedCount, maxUses: rc.maxUses }); return; }
    const refRole = referrer?.role === "student" ? "student" : "tutor";

    let changed = false;

    // 1) Credit referrer if not already granted
    if (!user.referralRewardGranted) {
      const aw1 = await walletService.getAdminWallet();
      if ((aw1?.balance || 0) < rewardAmount) {
        await walletService.adminCredit(rewardAmount, "Referral fund top-up", { type: "referral", id: paymentId });
      }
      await walletService.adminDebit(rewardAmount, "Referral reward", { type: "referral", id: paymentId });
      await walletService.creditWallet(user.referrerUserId, refRole, rewardAmount, "Referral reward", { type: "referral", id: paymentId });
      user.referralRewardGranted = true;
      console.log("referral:granted-referrer", { referrerUserId: user.referrerUserId, amount: rewardAmount, paymentId });
      changed = true;
    }

    // 2) Credit student signup bonus if configured and not yet granted
    const bonus = settings?.referredUserBonusAmount ?? 0;
    if (bonus > 0 && !user.referralSignupBonusGranted) {
      const aw2 = await walletService.getAdminWallet();
      if ((aw2?.balance || 0) < bonus) {
        await walletService.adminCredit(bonus, "Referral fund top-up", { type: "referral", id: paymentId });
      }
      await walletService.adminDebit(bonus, "Referral signup bonus", { type: "referral", id: paymentId });
      await walletService.creditWallet(user._id, "student", bonus, "Referral signup bonus", { type: "referral", id: paymentId });
      user.referralSignupBonusGranted = true;
      console.log("referral:granted-student-bonus", { studentUserId: user._id, bonus, paymentId });
      changed = true;
    }

    // 3) Credit student referral reward (full) if not yet granted
    if (!user.referralStudentRewardGranted) {
      const aw3 = await walletService.getAdminWallet();
      if ((aw3?.balance || 0) < rewardAmount) {
        await walletService.adminCredit(rewardAmount, "Referral fund top-up", { type: "referral", id: paymentId });
      }
      await walletService.adminDebit(rewardAmount, "Referral student reward", { type: "referral", id: paymentId });
      await walletService.creditWallet(user._id, "student", rewardAmount, "Referral student reward", { type: "referral", id: paymentId });
      user.referralStudentRewardGranted = true;
      console.log("referral:granted-student-reward", { studentUserId: user._id, amount: rewardAmount, paymentId });
      changed = true;
    }

    // 4) Record referral usage and attach paymentId idempotently
    if (rc) {
      const existing = await ReferralUse.findOne({ referralCodeId: rc._id, referredUserId: user._id });
      if (!existing) {
        await ReferralUse.create({ referralCodeId: rc._id, referrerUserId: user.referrerUserId, referredUserId: user._id, paymentId, rewardGranted: true, amountGranted: rewardAmount });
        rc.usedCount = (rc.usedCount || 0) + 1;
        await rc.save();
      } else if (paymentId && !existing.paymentId) {
        existing.paymentId = paymentId;
        await existing.save();
      }
    }

    // 5) Persist flags if any grants occurred
    if (changed) await user.save();

    // 6) Notifications (best-effort)
    try {
      const notificationService = require("../services/notificationService");
      await notificationService.notifyUser(
        user.referrerUserId,
        "Referral Reward Granted",
        `A referral reward was credited`,
        { paymentId, amountGranted: rewardAmount }
      );
      await notificationService.notifyUser(
        user._id,
        "Referral Bonus Applied", 
        bonus > 0 ? `A signup bonus was credited` : `Referral applied`,
        { paymentId, bonusAmount: bonus }
      );
    } catch (_) {}
  } catch (_) {}
}

/**
 * STUDENT: Create Razorpay ORDER for a regular class
 * Supports weekly / monthly / number-of-classes multiplier.
 *
 * POST /api/payments/create-subscription-order
 * Body: { regularClassId, billingType, numberOfClasses }
 *  - billingType: "weekly" | "monthly"
 *  - numberOfClasses: integer (e.g. 4, 8, 12)
 */
exports.createSubscriptionOrder = async (req, res) => {
  try {
    const { regularClassId, billingType, numberOfClasses, couponCode } = req.body;
    const userId = req.user.id; // student userId

    if (!regularClassId || !billingType) {
      return res.status(400).json({ success: false, message: "regularClassId and billingType are required" });
    }
    if (!["hourly", "monthly"].includes(String(billingType))) {
      return res.status(400).json({ success: false, message: "billingType must be 'hourly' or 'monthly'" });
    }
    const classes = billingType === "hourly" ? Number(numberOfClasses) : 1;
    if (billingType === "hourly" && (!classes || classes <= 0)) {
      return res.status(400).json({ success: false, message: "numberOfClasses must be > 0 for hourly billing" });
    }

    const rc = await RegularClass.findById(regularClassId);
    if (!rc) {
      return res
        .status(404)
        .json({ success: false, message: "Regular class not found" });
    }

    // 🔐 Optional: ensure the logged-in student matches this regular class
    // You can map User -> StudentProfile here if needed

    let totalAmountINR = billingType === "hourly" ? (Number(rc.amount) * classes) : Number(rc.amount);
    const { discount, coupon } = await applyCouponIfValid({ code: (couponCode || "").trim(), type: "subscription", amount: totalAmountINR, userId });
    if (discount > 0) totalAmountINR = Math.max(0, totalAmountINR - discount);
    const amountInPaise = Math.round(totalAmountINR * 100);
    if (amountInPaise < 100) {
      return res.status(400).json({ success: false, message: "Amount too low. Minimum ₹1 required." });
    }

    // If student wallet can fully cover, pay via wallet (no Razorpay)
    try {
      const wallet = await walletService.getWallet(userId);
      if (Number(wallet?.balance || 0) >= Number(totalAmountINR)) {
        const StudentProfile = require("../models/StudentProfile");
        const TutorProfile = require("../models/TutorProfile");
        const sp = await StudentProfile.findById(rc.studentId).select("userId name");
        const tp = await TutorProfile.findById(rc.tutorId).select("userId name");

        const commissionPercent = 25;
        const commissionAmount = (totalAmountINR * commissionPercent) / 100;
        const tutorNetAmount = totalAmountINR - commissionAmount;

        const paymentDoc = await Payment.findOneAndUpdate(
          { regularClassId },
          {
            regularClassId,
            studentId: rc.studentId,
            tutorId: rc.tutorId,
            type: "subscription",
            amount: totalAmountINR,
            currency: "INR",
            gateway: "wallet",
            status: "paid",
            periodStart: rc.currentPeriodStart,
            periodEnd: rc.currentPeriodEnd,
            notes: `BillingType: ${billingType}, Classes: ${classes}, Coupon:${couponCode || ""}, Discount:${discount || 0}`,
            commissionPercent,
            commissionAmount,
            tutorNetAmount,
          },
          { upsert: true, new: true }
        );

        await walletService.debitWallet(
          sp?.userId || userId,
          "student",
          Number(totalAmountINR),
          `Payment for regular class — Tutor: ${tp?.name || "Tutor"}${discount > 0 && (couponCode || "").trim() ? ` (Coupon ${(couponCode || "").trim()} -₹${discount})` : ""}`,
          { type: "booking", id: paymentDoc.regularClassId }
        );

        await walletService.adminIncreaseHold(tutorNetAmount);
        await walletService.creditPending(
          tp?.userId || rc.tutorId,
          "tutor",
          tutorNetAmount,
          `Payment received for class (locked) — Student: ${sp?.name || "Student"}`,
          { type: "booking", id: paymentDoc.regularClassId }
        );

        try {
          if ((couponCode || "").trim()) {
            const coupon = await Coupon.findOne({ code: (couponCode || "").trim() });
            await recordCouponUse({ coupon, userId: sp?.userId || userId, paymentId: paymentDoc._id, amountDiscounted: discount });
          }
          await grantReferralIfEligible({ studentUserId: sp?.userId || userId, paymentId: paymentDoc._id, amount: totalAmountINR });
        } catch (_) {}

        const baseDate = rc.currentPeriodEnd || rc.startDate || new Date();
        scheduleFundRelease(paymentDoc, baseDate);
        paymentDoc.walletProcessed = true;
        await paymentDoc.save();

        await createAdminNotification(
          "Subscription paid via wallet",
          `Regular class ${regularClassId} paid from wallet`,
          { regularClassId, paymentId: paymentDoc._id, amount: totalAmountINR }
        );

        return res.json({ success: true, walletPaid: true, paymentId: paymentDoc._id });
      }
    } catch (_) {}

    if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
      return res.status(500).json({ success: false, message: "Razorpay not configured" });
    }
    const safeReceipt = `rc_${Math.random().toString(36).substring(2, 10)}`;
    let order;
    try {
      order = await razorpay.orders.create({
        amount: amountInPaise,
        currency: "INR",
        receipt: safeReceipt,
        notes: {
          rc: regularClassId.toString().slice(-8),
          bt: billingType,
          cls: String(classes),
          coupon: couponCode || "",
          discount: String(discount || 0),
        },
      });
    } catch (e) {
      const msg = (e && (e.error?.description || e.message)) || "Payment provider error";
      console.error("Razorpay order create error:", msg);
      return res.status(500).json({ success: false, message: msg });
    }

    // 💾 Upsert Payment record for this regular class
    // type stays "subscription" because it's a recurring-tuition payment
    const paymentDoc = await Payment.findOneAndUpdate(
      { regularClassId },
      {
        regularClassId,
        studentId: rc.studentId,
        tutorId: rc.tutorId,
        type: "subscription",
        amount: totalAmountINR,
        currency: "INR",
        gateway: "razorpay",
        gatewayOrderId: order.id,
        status: "created",
        periodStart: rc.currentPeriodStart,
        periodEnd: rc.currentPeriodEnd,
        notes: `BillingType: ${billingType}, Classes: ${classes}, Coupon:${couponCode || ""}, Discount:${discount || 0}`,
      },
      { upsert: true, new: true }
    );

    await createAdminNotification(
      "Regular class payment initiated",
      `Order ${order.id} created for regularClass ${regularClassId}`,
      {
        regularClassId,
        paymentId: paymentDoc._id,
        billingType,
        numberOfClasses,
        amount: totalAmountINR,
      }
    );

    return res.json({
      success: true,
      key: process.env.RAZORPAY_KEY_ID,
      orderId: order.id,
      amount: amountInPaise,
      currency: "INR",
    });
  } catch (err) {
    console.error("createSubscriptionOrder error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Server error", error: err.message });
  }
};

/**
 * GROUP BATCH: Create Razorpay ORDER for a reserved seat
 * POST /api/payments/group/create-order
 * Body: { batchId, reservationId }
 * Flow: Ensure active hold exists for this student → create order → persist Payment(type="group")
 */
exports.createGroupOrder = async (req, res) => {
  try {
    const { batchId, reservationId, couponCode } = req.body;
    const months = Number(req.body?.months ?? 1);
    const userId = req.user.id;
    const StudentProfile = require("../models/StudentProfile");
    const TutorProfile = require("../models/TutorProfile");
    const sp = await StudentProfile.findOne({ userId }).select("_id");
    if (!sp) return res.status(404).json({ success: false, message: "Student profile not found" });

    const gb = await GroupBatch.findById(batchId);
    if (!gb || gb.status !== "active" || !gb.published) {
      return res.status(404).json({ success: false, message: "Batch not available" });
    }

    if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
      return res.status(500).json({ success: false, message: "Razorpay not configured" });
    }

    const now = Date.now();
    // Allow renewing? Check hold or existing enrollment
    // If just joining, check hold
    // If renewing, hold might not exist.
    // For now, assume hold check is for new joiners or waitlist.
    const hold = (gb.holds || []).find(
      (h) => String(h.studentId) === String(sp._id) && h.status === "active" && new Date(h.expiresAt).getTime() > now
    );
    // If not in hold, check if already enrolled (renewal)
    const isEnrolled = gb.enrolled.some(id => String(id) === String(sp._id));
    if (!hold && !isEnrolled) return res.status(409).json({ success: false, message: "Seat reservation expired or missing" });

    if (!Number.isInteger(months) || months < 1 || months > 60) {
      return res.status(400).json({ success: false, message: "Invalid months" });
    }

    let amountINR = Number(gb.pricePerStudent || 0) * months;
    const { discount } = await applyCouponIfValid({ code: (couponCode || "").trim(), type: "group", amount: amountINR, userId });
    if (discount > 0) amountINR = Math.max(0, amountINR - discount);
    const amountInPaise = Math.round(amountINR * 100);

    // Calculate period (full batch)
    const currentEnrollment = (gb.enrollmentDetails || []).find((e) => String(e.studentId) === String(sp._id));
    const nowDate = new Date();
    const batchStart = gb.batchStartDate ? new Date(gb.batchStartDate) : null;
    const enrollmentValidUntil = currentEnrollment?.validUntil ? new Date(currentEnrollment.validUntil) : null;
    let startDate = nowDate;
    if (enrollmentValidUntil && enrollmentValidUntil > nowDate) {
      startDate = enrollmentValidUntil;
    } else if (batchStart && batchStart > nowDate) {
      startDate = batchStart;
    }
    const endDate = new Date(startDate);
    endDate.setMonth(endDate.getMonth() + months);

    // Wallet-only payment if balance suffices
    try {
      const wallet = await walletService.getWallet(userId);
      if (Number(wallet?.balance || 0) >= Number(amountINR)) {
        const paymentDoc = await Payment.create({
          type: "group",
          groupBatchId: gb._id,
          studentId: sp._id,
          tutorId: gb.tutorId,
          amount: amountINR,
          currency: "INR",
          gateway: "wallet",
          status: "paid",
          notes: `Group batch checkout for ${batchId}, Months:${months}, Coupon:${couponCode || ""}, Discount:${discount || 0}`,
          periodStart: startDate,
          periodEnd: endDate
        });

        const tp = await TutorProfile.findById(gb.tutorId).select("userId name");
        const commissionPercent = 25;
        const commissionAmount = (amountINR * commissionPercent) / 100;
        const tutorNetAmount = amountINR - commissionAmount;

        await walletService.debitWallet(
          userId,
          "student",
          Number(amountINR),
          `Payment for group batch — Tutor: ${tp?.name || "Tutor"}${discount > 0 && (couponCode || "").trim() ? ` (Coupon ${(couponCode || "").trim()} -₹${discount})` : ""}`,
          { type: "group", id: paymentDoc.groupBatchId }
        );

        await walletService.adminIncreaseHold(tutorNetAmount);
        await walletService.creditPending(
          tp?.userId || gb.tutorId,
          "tutor",
          tutorNetAmount,
          `Payment received for group batch (locked) — Student: ${sp?._id || "Student"}`,
          { type: "group", id: paymentDoc.groupBatchId }
        );

        try {
          if ((couponCode || "").trim()) {
            const coupon = await Coupon.findOne({ code: (couponCode || "").trim() });
            await recordCouponUse({ coupon, userId, paymentId: paymentDoc._id, amountDiscounted: discount });
          }
          await grantReferralIfEligible({ studentUserId: userId, paymentId: paymentDoc._id, amount: amountINR });
        } catch (_) {}

        await createAdminNotification(
          "Group batch paid via wallet",
          `Batch ${batchId} paid from wallet`,
          { batchId, paymentId: paymentDoc._id, amount: amountINR }
        );

        // Auto-verify/enroll for wallet payment
        // We need to call verification logic or duplicate it. 
        // Ideally refactor verification to a function.
        // For now, I'll just replicate the enrollment update here as it's cleaner than self-calling API.
        
        gb.enrollmentDetails = gb.enrollmentDetails || [];
        const existingIdx = gb.enrollmentDetails.findIndex(e => String(e.studentId) === String(sp._id));
        if (existingIdx !== -1) {
            gb.enrollmentDetails[existingIdx].validUntil = endDate;
        } else {
            gb.enrollmentDetails.push({
                studentId: sp._id,
                validUntil: endDate,
                joinedAt: new Date()
            });
        }
        if (!gb.enrolled.includes(sp._id)) gb.enrolled.push(sp._id);
        
        if (hold) {
            const hIdx = gb.holds.indexOf(hold);
            if (hIdx !== -1) gb.holds[hIdx].status = "finalized";
        }
        await gb.save();

        return res.json({ success: true, walletPaid: true, paymentId: paymentDoc._id });
      }
    } catch (e) { console.log(e); }

    const safeReceipt = `gb_${Math.random().toString(36).substring(2, 10)}`;
    const order = await razorpay.orders.create({
      amount: amountInPaise,
      currency: "INR",
      receipt: safeReceipt,
      notes: { batchId: batchId.toString().slice(-8), studentId: sp._id.toString().slice(-8), coupon: couponCode || "", discount: String(discount || 0) },
    });

    const paymentDoc = await Payment.create({
      type: "group",
      groupBatchId: gb._id,
      studentId: sp._id,
      tutorId: gb.tutorId,
      amount: amountINR,
      currency: "INR",
      gateway: "razorpay",
      gatewayOrderId: order.id,
      status: "created",
      notes: `Group batch checkout for ${batchId}, Months:${months}, Coupon:${couponCode || ""}, Discount:${discount || 0}`,
      periodStart: startDate,
      periodEnd: endDate
    });

    // Link orderId to the student's active seat hold for traceability
    if (hold) {
        hold.orderId = order.id;
        await gb.save();
    }

    await createAdminNotification(
      "Group batch payment initiated",
      `Order ${order.id} created for batch ${batchId}`,
      { batchId, paymentId: paymentDoc._id, amount: amountINR }
    );
    const metrics = require("../services/metricsService");
    metrics.emit("group.checkout.initiated", { batchId }, { amount: amountINR });

    return res.json({ success: true, key: process.env.RAZORPAY_KEY_ID, orderId: order.id, amount: amountInPaise, currency: "INR" });
  } catch (err) {
    console.error("createGroupOrder error:", err);
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

exports.createNoteOrder = async (req, res) => {
  try {
    const { noteId, couponCode } = req.body;
    const userId = req.user.id;
    const StudentProfile = require("../models/StudentProfile");
    const sp = await StudentProfile.findOne({ userId }).select("_id");
    const studentId = sp?._id || userId;

    if (!noteId) {
      return res.status(400).json({ success: false, message: "noteId is required" });
    }

    const note = await Note.findById(noteId);
    if (!note) {
      return res.status(404).json({ success: false, message: "Note not found" });
    }

    if (Number(note.price) <= 0) {
      const paymentDoc = await Payment.create({
        type: "note",
        noteId: note._id,
        studentId,
        tutorId: note.tutorId,
        amount: 0,
        currency: "INR",
        gateway: "free",
        status: "paid",
      });

      await createAdminNotification(
        "Free note claimed",
        `Free note ${note._id} claimed by student ${studentId}`,
        { noteId: note._id, paymentId: paymentDoc._id }
      );

      return res.json({ success: true, free: true });
    }

    let amountINR = Number(note.price);
    const { discount } = await applyCouponIfValid({ code: (couponCode || "").trim(), type: "note", amount: amountINR, userId });
    if (discount > 0) amountINR = Math.max(0, amountINR - discount);
    const amountInPaise = Math.round(amountINR * 100);

    // Wallet-only payment path
    try {
      const wallet = await walletService.getWallet(userId);
      if (Number(wallet?.balance || 0) >= Number(amountINR)) {
        const paymentDoc = await Payment.create({
          type: "note",
          noteId: note._id,
          studentId,
          tutorId: note.tutorId,
          amount: amountINR,
          currency: "INR",
          gateway: "wallet",
          status: "paid",
        });

        const TutorProfile = require("../models/TutorProfile");
        const StudentProfile = require("../models/StudentProfile");
        const tp = await TutorProfile.findById(note.tutorId).select("userId name");
        const sp2 = await StudentProfile.findById(studentId).select("userId name");
        const tutorUserId = tp?.userId || note.tutorId;
        const studentUserId = sp2?.userId || studentId;

        const commissionPercent = 25;
        const commissionAmount = (amountINR * commissionPercent) / 100;
        const tutorNetAmount = amountINR - commissionAmount;

        await walletService.debitWallet(
          studentUserId,
          "student",
          Number(amountINR),
          `Payment for note — Tutor: ${tp?.name || "Tutor"}${discount > 0 && (couponCode || "").trim() ? ` (Coupon ${(couponCode || "").trim()} -₹${discount})` : ""}`,
          { type: "note", id: note._id }
        );

        await walletService.adminIncreaseHold(tutorNetAmount);
        await walletService.creditPending(
          tutorUserId,
          "tutor",
          tutorNetAmount,
          `Payment received for note (locked) — Student: ${sp2?.name || "Student"}`,
          { type: "note", id: note._id }
        );

        try {
          if ((couponCode || "").trim()) {
            const coupon = await Coupon.findOne({ code: (couponCode || "").trim() });
            await recordCouponUse({ coupon, userId: studentUserId, paymentId: paymentDoc._id, amountDiscounted: discount });
          }
          await grantReferralIfEligible({ studentUserId, paymentId: paymentDoc._id, amount: amountINR });
        } catch (_) {}

        await createAdminNotification(
          "Note purchase paid via wallet",
          `Note ${note._id} paid from wallet`,
          { noteId: note._id, paymentId: paymentDoc._id, amount: amountINR }
        );

        return res.json({ success: true, walletPaid: true, paymentId: paymentDoc._id });
      }
    } catch (_) {}

    if (!process.env.RAZORPAY_KEY_ID) {
      return res.status(500).json({ success: false, message: "Razorpay key not configured" });
    }

    const safeReceipt = `nt_${Math.random().toString(36).substring(2, 10)}`;
    const order = await razorpay.orders.create({
      amount: amountInPaise,
      currency: "INR",
      receipt: safeReceipt,
      notes: {
        n: noteId.toString().slice(-8),
        t: note.tutorId.toString().slice(-8),
        coupon: couponCode || "",
        discount: String(discount || 0),
      },
    });

    const paymentDoc = await Payment.create({
      type: "note",
      noteId: note._id,
      studentId,
      tutorId: note.tutorId,
      amount: amountINR,
      currency: "INR",
      gateway: "razorpay",
      gatewayOrderId: order.id,
      status: "created",
    });

    return res.json({
      success: true,
      key: process.env.RAZORPAY_KEY_ID,
      razorpayKey: process.env.RAZORPAY_KEY_ID,
      orderId: order.id,
      amount: amountInPaise,
      currency: "INR",
      paymentId: paymentDoc._id,
    });
  } catch (err) {
    console.error("createNoteOrder error:", err);
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

/**
 * POST /api/payments/razorpay/webhook
 * Razorpay will call this when payment is captured
 * NOTE: use express.raw({ type: "application/json" }) on this route
 */
exports.razorpayWebhook = async (req, res) => {
  try {
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
    const signature = req.headers["x-razorpay-signature"];

    if (!signature || !webhookSecret) {
      return res.status(400).json({ received: false });
    }

    const rawBody = Buffer.isBuffer(req.body)
      ? req.body
      : Buffer.from(JSON.stringify(req.body));

    const expected = crypto
      .createHmac("sha256", webhookSecret)
      .update(rawBody)
      .digest("hex");

    if (expected !== signature) {
      return res.status(400).json({ received: false });
    }

    const event = JSON.parse(rawBody.toString("utf8"));

    if (event.event && (event.event.includes("refund") || event.event === "refund.processed")) {
      const RefundRequest = require("../models/RefundRequest");
      const ref = (event.payload && event.payload.refund && event.payload.refund.entity) || null;
      if (!ref || !ref.id) return res.status(200).json({ received: true });
      const rr = await RefundRequest.findOne({ providerRefundId: ref.id });
      if (!rr) return res.status(200).json({ received: true });
      rr.providerStatus = ref.status || rr.providerStatus;
      if ((ref.status || "").toLowerCase() === "processed") {
        rr.status = "processed";
        rr.processedAt = new Date();
        await rr.save();
        const payment = await Payment.findById(rr.paymentId);
        if (payment) {
          const amt = Math.round(Number(ref.amount || 0)) / 100;
          payment.refundTotal = Math.max(0, Number(payment.refundTotal || 0) + Number(amt));
          if (!Array.isArray(payment.refunds)) payment.refunds = [];
          if (!payment.refunds.find((x) => String(x) === String(rr._id))) payment.refunds.push(rr._id);
          await payment.save();
          try {
            const TutorProfile = require("../models/TutorProfile");
            const StudentProfile = require("../models/StudentProfile");
            const tp = await TutorProfile.findById(payment.tutorId).select("userId name");
            const sp = await StudentProfile.findById(payment.studentId).select("userId name");
            const tutorUserId = tp?.userId || payment.tutorId;
            const studentUserId = sp?.userId || payment.studentId;
            const commissionPercent = Number(payment.commissionPercent || 25);
            const commissionAmount = (Number(amt) * commissionPercent) / 100;
            const tutorNetAmount = Math.max(0, Number(amt) - commissionAmount);
            const ctx = await getRefundContext(payment._id);
            const locked = ctx.payoutState !== "released";
            if (locked) {
              await walletService.adminDecreaseHold(tutorNetAmount);
              await walletService.reversePending(tutorUserId, "tutor", tutorNetAmount, "Refund adjustment", { type: "refund", id: rr._id });
            } else {
              await walletService.debitOrRecordAdjustment(tutorUserId, "tutor", tutorNetAmount, "Refund adjustment", { type: "refund", id: rr._id });
            }
            try {
              const notificationService = require("../services/notificationService");
              await notificationService.notifyUser(studentUserId, "Refund Processed", "Your refund has been processed", { refundRequestId: rr._id, amount: amt });
              await notificationService.notifyUser(tutorUserId, "Refund Adjustment", "A refund adjustment affected your earnings", { refundRequestId: rr._id, amount: tutorNetAmount });
            } catch (_) {}
            if (payment.type === "note" && Number(payment.refundTotal || 0) >= Number(payment.amount || 0)) {
              await createAdminNotification("Note refund processed", "Access revoked after full refund", { refundRequestId: rr._id, paymentId: payment._id });
            }
            if (payment.type === "subscription" && Number(payment.refundTotal || 0) >= Number(payment.amount || 0)) {
              const rc = payment.regularClassId ? await RegularClass.findById(payment.regularClassId) : null;
              if (rc && rc.status !== 'ended') {
                rc.status = "paused";
                await rc.save();
              }
              try {
                const Session = require("../models/Session");
                if (rc) await Session.deleteMany({ regularClassId: rc._id, status: "scheduled" });
              } catch (_) {}
            }
          } catch (_) {}
        }
      } else {
        await rr.save();
      }
      return res.status(200).json({ received: true });
    }

  if (event.event === "payment.captured") {
      const paymentId = event.payload.payment.entity.id;
      const orderId = event.payload.payment.entity.order_id;
      const amount = event.payload.payment.entity.amount / 100;
      const notes = event.payload.payment.entity.notes;

      let payment = await Payment.findOne({
        $or: [{ gatewayPaymentId: paymentId }, { gatewayOrderId: orderId }],
      });

      if (!payment) {
        return res.status(200).json({ received: true });
      }

      // MARK PAYMENT AS PAID
      payment.status = "paid";
      payment.gatewayPaymentId = paymentId;
      payment.amount = amount;
      await payment.save();

      // UPDATE REGULAR CLASS
      const rc = await RegularClass.findById(payment.regularClassId);

      if (rc) {
        rc.paymentStatus = "paid";
        rc.tutorPaymentStatus = "locked";

        // 🔥 FIX — Update classCount for hourly
        if (rc.planType === "hourly") {
          const purchased = Number((notes && (notes.numberOfClasses || notes.cls)) || 0);
          rc.classCount = purchased;
        }

        await rc.save();

        // Wallet updates: Admin hold and Tutor pending credit (Regular Class)
        try {
          if (!payment.walletProcessed) {
            const commissionPercent = 25;
            const commissionAmount = (amount * commissionPercent) / 100;
            const tutorNetAmount = amount - commissionAmount;

            // Admin receives full amount and holds tutor's share
            await walletService.adminCredit(amount, "Subscription payment captured", { type: "booking", id: payment.regularClassId });
            await walletService.adminIncreaseHold(tutorNetAmount);

            // Tutor sees locked credit immediately
            const TutorProfile = require("../models/TutorProfile");
            const StudentProfile = require("../models/StudentProfile");
            const tp = await TutorProfile.findById(rc.tutorId).select("userId name");
            const sp = await StudentProfile.findById(rc.studentId).select("userId name");
            const tutorUserId = tp?.userId || rc.tutorId;
            const studentUserId = sp?.userId || rc.studentId;
            await walletService.creditPending(
              tutorUserId,
              "tutor",
              tutorNetAmount,
              `Payment received for class (locked) — Student: ${sp?.name || "Student"}`,
              { type: "booking", id: payment.regularClassId }
            );

            // Student wallet history (virtual debit)
            const couponCode = notes && notes.coupon;
            const discountVal = Number(notes && notes.discount ? notes.discount : 0) || 0;
            const descExtra = discountVal > 0 && couponCode ? ` (Coupon ${couponCode} -₹${discountVal})` : "";
            await walletService.addTransaction({
              userId: studentUserId,
              type: "debit",
              amount,
              description: `Payment for regular class — Tutor: ${tp?.name || "Tutor"}${descExtra}`,
              reference: { type: "booking", id: payment.regularClassId },
              status: "completed",
              regularClassId: payment.regularClassId,
              paymentId: payment._id,
            });

            // Schedule release after 30 days of period end (or startDate)
            const baseDate = rc.currentPeriodEnd || rc.startDate || new Date();
            scheduleFundRelease(payment, baseDate);
            payment.walletProcessed = true;
            await payment.save();
          }
        } catch (walletErr) {
          console.error("Wallet update error:", walletErr.message);
        }

        // Record coupon usage and grant referral after successful capture
        try {
          const couponCode = notes && notes.coupon;
          const discountVal = Number(notes && notes.discount ? notes.discount : 0) || 0;
          if (couponCode) {
            const coupon = await Coupon.findOne({ code: couponCode });
            await recordCouponUse({ coupon, userId: studentUserId, paymentId: payment._id, amountDiscounted: discountVal });
          }
          await grantReferralIfEligible({ studentUserId, paymentId: payment._id, amount });
        } catch (_) {}
      }

      await createAdminNotification(
        "Subscription payment received",
        `Payment ${payment._id} captured`,
        {
          paymentId: payment._id,
          regularClassId: payment.regularClassId,
          gatewayPaymentId: paymentId,
          gatewayOrderId: orderId,
          amount,
        }
      );
    }

    // Handle note purchases via webhook as well
    if (payment.type === "note") {
      try {
        const nId = payment.noteId;
        const note = await Note.findById(nId);
        if (note) {
          const amt = payment.amount || Number(note.price) || 0;
          const commissionPercent = 25;
          const commissionAmount = (amt * commissionPercent) / 100;
          const tutorNetAmount = amt - commissionAmount;

          if (!payment.walletProcessed) {
            await walletService.adminCredit(amt, "Note purchase captured", { type: "note", id: nId });
            await walletService.adminIncreaseHold(tutorNetAmount);

            const TutorProfile = require("../models/TutorProfile");
            const StudentProfile = require("../models/StudentProfile");
            const tp = await TutorProfile.findById(payment.tutorId).select("userId name");
            const sp = await StudentProfile.findById(payment.studentId).select("userId name");
            const tutorUserId = tp?.userId || payment.tutorId;
            const studentUserId = sp?.userId || payment.studentId;
            await walletService.creditPending(
              tutorUserId,
              "tutor",
              tutorNetAmount,
              `Payment received for note (locked) — Student: ${sp?.name || "Student"}`,
              { type: "note", id: nId }
            );
            const cn = (notes && notes.coupon) || "";
            const dn = Number(notes && notes.discount ? notes.discount : 0) || 0;
            const descExtraNote = dn > 0 && cn ? ` (Coupon ${cn} -₹${dn})` : "";
            await walletService.addTransaction({
              userId: studentUserId,
              type: "debit",
              amount: amt,
              description: `Payment for note — Tutor: ${tp?.name || "Tutor"}${descExtraNote}`,
              reference: { type: "note", id: nId },
              status: "completed",
              paymentId: payment._id,
            });

            const baseDate = new Date();
            scheduleFundRelease(payment, baseDate);
            payment.walletProcessed = true;
            await payment.save();
          }

          try {
            const couponCode = notes && notes.coupon;
            const discountVal = Number(notes && notes.discount ? notes.discount : 0) || 0;
            if (couponCode) {
              const coupon = await Coupon.findOne({ code: couponCode });
              const StudentProfile = require("../models/StudentProfile");
            const sp2 = await StudentProfile.findById(payment.studentId).select("userId");
            const studentUserId2 = sp2?.userId;
            if (studentUserId2) {
              await recordCouponUse({ coupon, userId: studentUserId2, paymentId: payment._id, amountDiscounted: discountVal });
            }
            }
            const StudentProfile = require("../models/StudentProfile");
            const sp3 = await StudentProfile.findById(payment.studentId).select("userId");
            const studentUserId3 = sp3?.userId;
            if (studentUserId3) {
              await grantReferralIfEligible({ studentUserId: studentUserId3, paymentId: payment._id, amount: amt });
            }
          } catch (_) {}

          await createAdminNotification(
            "Note payment received",
            `Note payment ${payment._id} captured`,
            { paymentId: payment._id, noteId: nId, gatewayPaymentId: paymentId, gatewayOrderId: orderId, amount: amt }
          );
        }
      } catch (err2) {
        console.error("Webhook note handling error:", err2.message);
      }
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("Webhook ERR", err);
    return res.status(500).json({ received: false });
  }
};

exports.razorpayxWebhook = async (req, res) => {
  try {
    const webhookSecret = process.env.RAZORPAYX_WEBHOOK_SECRET;
    const signature = req.headers["x-razorpay-signature"] || req.headers["X-Razorpay-Signature"];
    if (!signature || !webhookSecret) {
      return res.status(400).json({ received: false });
    }
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body));
    const expected = require("crypto").createHmac("sha256", webhookSecret).update(rawBody).digest("hex");
    if (expected !== signature) {
      return res.status(400).json({ received: false });
    }
    const event = JSON.parse(rawBody.toString("utf8"));
    const type = event.event;
    const payoutEntity = event.payload && event.payload.payout && event.payload.payout.entity;
    const payoutId = payoutEntity && payoutEntity.id;
    const status = payoutEntity && payoutEntity.status;
    if (!payoutId) return res.status(200).json({ received: true });

    const Payment = require("../models/Payment");
    const RefundRequest = require("../models/RefundRequest");
    const p = await Payment.findOne({ type: "payout", gatewayPaymentId: payoutId });
    const rr = p ? null : await RefundRequest.findOne({ providerRefundId: payoutId }) || (event.payload?.payout?.entity?.reference_id ? await RefundRequest.findById(event.payload.payout.entity.reference_id) : null);
    if (!p && !rr) return res.status(200).json({ received: true });

    if (p) {
      if (status === "processed") {
        p.status = "settled";
        await p.save();
      } else if (status === "reversed" || status === "rejected" || status === "cancelled") {
        p.status = "failed";
        await p.save();
        const TutorProfile = require("../models/TutorProfile");
        const tp = await TutorProfile.findById(p.tutorId).select("userId");
        const userId = tp?.userId || null;
        if (userId) {
          const Wallet = require("../models/Wallet");
          const w = await Wallet.findOne({ userId });
          if (w) {
            w.balance += Number(p.tutorNetAmount || p.amount || 0);
            await w.save();
          }
          const walletService = require("../services/payments/walletService");
          await walletService.addTransaction({ userId, type: "credit", amount: Number(p.tutorNetAmount || p.amount || 0), description: "Payout reversal", reference: { type: "payout", id: p._id }, status: "completed", paymentId: p._id });
        }
      }
    } else if (rr) {
      rr.providerStatus = status;
      if (status === "processed") {
        rr.status = "processed";
        rr.processedAt = new Date();
        await rr.save();
        const payment = await Payment.findById(rr.paymentId);
        if (payment) {
          const amt = Number(rr.amountApproved || rr.amount || 0);
          payment.refundTotal = Math.max(0, Number(payment.refundTotal || 0) + Number(amt));
          if (!Array.isArray(payment.refunds)) payment.refunds = [];
          if (!payment.refunds.find((x) => String(x) === String(rr._id))) payment.refunds.push(rr._id);
          await payment.save();
          try {
            const TutorProfile = require("../models/TutorProfile");
            const StudentProfile = require("../models/StudentProfile");
            const tp = await TutorProfile.findById(payment.tutorId).select("userId name");
            const sp = await StudentProfile.findById(payment.studentId).select("userId name");
            const tutorUserId = tp?.userId || payment.tutorId;
            const studentUserId = sp?.userId || payment.studentId;
            const commissionPercent = Number(payment.commissionPercent || 25);
            const commissionAmount = (Number(amt) * commissionPercent) / 100;
            const tutorNetAmount = Math.max(0, Number(amt) - commissionAmount);
            const ctx = await getRefundContext(payment._id);
            const locked = ctx.payoutState !== "released";
            if (locked) {
              await walletService.adminDecreaseHold(tutorNetAmount);
              await walletService.reversePending(tutorUserId, "tutor", tutorNetAmount, "Refund adjustment", { type: "refund", id: rr._id });
            } else {
              await walletService.debitOrRecordAdjustment(tutorUserId, "tutor", tutorNetAmount, "Refund adjustment", { type: "refund", id: rr._id });
            }
            try {
              const notificationService = require("../services/notificationService");
              await notificationService.notifyUser(studentUserId, "Refund Processed", "Your refund has been processed", { refundRequestId: rr._id, amount: amt });
              await notificationService.notifyUser(tutorUserId, "Refund Adjustment", "A refund adjustment affected your earnings", { refundRequestId: rr._id, amount: tutorNetAmount });
            } catch (_) {}
            if (payment.type === "note" && Number(payment.refundTotal || 0) >= Number(payment.amount || 0)) {
              await createAdminNotification("Note refund processed", "Access revoked after full refund", { refundRequestId: rr._id, paymentId: payment._id });
            }
            if (payment.type === "subscription" && Number(payment.refundTotal || 0) >= Number(payment.amount || 0)) {
              const rc = payment.regularClassId ? await RegularClass.findById(payment.regularClassId) : null;
              if (rc && rc.status !== 'ended') {
                rc.status = "paused";
                await rc.save();
              }
              try {
                const Session = require("../models/Session");
                if (rc) await Session.deleteMany({ regularClassId: rc._id, status: "scheduled" });
              } catch (_) {}
            }
          } catch (_) {}
        }
      } else {
        await rr.save();
      }
    }
    res.status(200).json({ received: true });
  } catch (err) {
    res.status(500).json({ received: false });
  }
};


/**
 * POST /api/payments/verify
 * Client-side verification of Razorpay payment signature.
 * Body: { orderId, paymentId, signature, regularClassId, billingType, numberOfClasses }
 * Marks Payment and RegularClass as paid upon successful verification.
 */
exports.verifyPayment = async (req, res) => {
  try {
    const { orderId, paymentId, signature, regularClassId, billingType, numberOfClasses, noteId } = req.body;

    if (!orderId || !paymentId || !signature) {
      return res.status(400).json({ success: false, message: "orderId, paymentId, signature are required" });
    }

    const secret = process.env.RAZORPAY_KEY_SECRET;
    if (!secret) {
      return res.status(500).json({ success: false, message: "Razorpay secret not configured" });
    }

    const expected = crypto
      .createHmac("sha256", secret)
      .update(`${orderId}|${paymentId}`)
      .digest("hex");

    if (expected !== signature) {
      return res.status(400).json({ success: false, message: "Invalid signature" });
    }

    // Find payment by orderId
    const payment = await Payment.findOne({ gatewayOrderId: orderId });
    if (!payment) {
      return res.status(404).json({ success: false, message: "Payment record not found" });
    }

    // Mark payment as paid
    payment.status = "paid";
    payment.gatewayPaymentId = paymentId;
    await payment.save();

    // Update RegularClass payment status
    const rcId = regularClassId || payment.regularClassId;
    if (rcId) {
      const rc = await RegularClass.findById(rcId);
      if (rc) {
        rc.paymentStatus = "paid";
        rc.tutorPaymentStatus = "locked";
        if (rc.planType === "hourly") {
          const purchased = Number(numberOfClasses || 0);
          if (purchased > 0) rc.classCount = purchased;
        }
        await rc.save();
      }

      // Wallet + release schedule
      try {
        if (!payment.walletProcessed) {
          const amount = payment.amount || 0;
          const commissionPercent = 25;
          const commissionAmount = (amount * commissionPercent) / 100;
          const tutorNetAmount = amount - commissionAmount;

          // Admin receives full amount and holds tutor's share
          await walletService.adminCredit(amount, "Subscription payment verified", { type: "booking", id: payment.regularClassId });
          await walletService.adminIncreaseHold(tutorNetAmount);

          const rc2 = await RegularClass.findById(rcId);
          if (rc2) {
            const TutorProfile = require("../models/TutorProfile");
            const StudentProfile = require("../models/StudentProfile");
            const tp = await TutorProfile.findById(rc2.tutorId).select("userId name");
            const sp = await StudentProfile.findById(rc2.studentId).select("userId name");
            const tutorUserId = tp?.userId || rc2.tutorId;
            const studentUserId = sp?.userId || rc2.studentId;
            await walletService.creditPending(
              tutorUserId,
              "tutor",
              tutorNetAmount,
              `Payment received for class (locked) — Student: ${sp?.name || "Student"}`,
              { type: "booking", id: payment.regularClassId }
            );

            // Student wallet history
            const noteStr = String(payment.notes || "");
            const cm = noteStr.match(/Coupon:([^,]*)/);
            const dm = noteStr.match(/Discount:(\d+)/);
            const code = cm && cm[1] ? cm[1].trim() : "";
            const disc = dm && dm[1] ? Number(dm[1]) : 0;
            const descExtra = disc > 0 && code ? ` (Coupon ${code} -₹${disc})` : "";
            await walletService.addTransaction({
              userId: studentUserId,
              type: "debit",
              amount,
              description: `Payment for regular class — Tutor: ${tp?.name || "Tutor"}${descExtra}`,
              reference: { type: "booking", id: payment.regularClassId },
              status: "completed",
              regularClassId: payment.regularClassId,
              paymentId: payment._id,
            });

            const baseDate = rc2.currentPeriodEnd || rc2.startDate || new Date();
            scheduleFundRelease(payment, baseDate);
            payment.walletProcessed = true;
            await payment.save();

            try {
              const notificationService = require("../services/notificationService");
              await notificationService.notifyUser(
                studentUserId,
                "Payment Verified",
                `Payment verified for your classes with ${tp?.name || "Tutor"}`,
                { paymentId: payment._id, regularClassId: payment.regularClassId }
              );
              await notificationService.notifyUser(
                tutorUserId,
                "Payment Locked",
                `A class payment was received and locked for release`,
                { paymentId: payment._id, regularClassId: payment.regularClassId }
              );
            } catch (_) {}
          }
        }
      } catch (walletErr) {
        console.error("Wallet update error:", walletErr.message);
      }

      // Coupon/referral recording for subscription (client verify)
      try {
        const StudentProfile = require("../models/StudentProfile");
        const sp3 = await StudentProfile.findById(payment.studentId).select("userId");
        const studentUserIdX = sp3?.userId;
        const noteStr = String(payment.notes || "");
        const cMatch = noteStr.match(/Coupon:([^,]*)/);
        const dMatch = noteStr.match(/Discount:(\d+)/);
        const code = cMatch && cMatch[1] ? cMatch[1].trim() : "";
        const disc = dMatch && dMatch[1] ? Number(dMatch[1]) : 0;
        if (code && studentUserIdX) {
          const coupon = await Coupon.findOne({ code });
          await recordCouponUse({ coupon, userId: studentUserIdX, paymentId: payment._id, amountDiscounted: disc });
        }
        if (studentUserIdX) {
          await grantReferralIfEligible({ studentUserId: studentUserIdX, paymentId: payment._id, amount });
        }
      } catch (_) {}
    }

    // Notes processing (idempotent and independent of rcId)
    if (noteId || payment.type === "note") {
      const nId = noteId || payment.noteId;
      const note = await Note.findById(nId);
      if (!note) {
        return res.status(404).json({ success: false, message: "Note not found" });
      }

      try {
        if (!payment.walletProcessed) {
          const amount = payment.amount || Number(note.price) || 0;
          const commissionPercent = 25;
          const commissionAmount = (amount * commissionPercent) / 100;
          const tutorNetAmount = amount - commissionAmount;

          // 1) Admin receives amount and holds tutor share
          await walletService.adminCredit(amount, "Note purchase verified", { type: "note", id: nId });
          await walletService.adminIncreaseHold(tutorNetAmount);

          const TutorProfile = require("../models/TutorProfile");
          const StudentProfile = require("../models/StudentProfile");
          const tutorProfile = await TutorProfile.findById(payment.tutorId).select("userId name");
          const studentProfile = await StudentProfile.findById(payment.studentId).select("userId name");
          const tutorUserId = tutorProfile?.userId || payment.tutorId;
          const studentUserId = studentProfile?.userId || payment.studentId;

          // 2) Tutor gets locked pending credit
          await walletService.creditPending(
            tutorUserId,
            "tutor",
            tutorNetAmount,
            `Payment received for note (locked) — Student: ${studentProfile?.name || "Student"}`,
            { type: "note", id: nId }
          );

          // 3) Student wallet history debit (virtual)
          await walletService.addTransaction({
            userId: studentUserId,
            type: "debit",
            amount,
            description: `Payment for note — Tutor: ${tutorProfile?.name || "Tutor"}`,
            reference: { type: "note", id: nId },
            status: "completed",
            paymentId: payment._id,
          });

          // 4) Schedule release and mark processed
          const baseDate = new Date();
          scheduleFundRelease(payment, baseDate);
          payment.walletProcessed = true;
          await payment.save();

          // 5) Notify parties (best-effort)
          try {
            const notificationService = require("../services/notificationService");
            await notificationService.notifyUser(
              studentUserId,
              "Payment Verified",
              `Payment verified for your note purchase`,
              { paymentId: payment._id, noteId: nId }
            );
            await notificationService.notifyUser(
              tutorUserId,
              "Payment Locked",
              `A note payment was received and locked for release`,
              { paymentId: payment._id, noteId: nId }
            );
          } catch (_) {}
        }
        // 6) Referral grant (client verify path): link student and award if eligible
        try {
          const StudentProfile = require("../models/StudentProfile");
          const sp4 = await StudentProfile.findById(payment.studentId).select("userId");
          const studentUserIdY = sp4?.userId || req.user?.id;
          if (studentUserIdY) {
            await grantReferralIfEligible({ studentUserId: studentUserIdY, paymentId: payment._id, amount: payment.amount || Number(note.price) || 0 });
          }
        } catch (_) {}
      } catch (walletErr) {
        console.error("Wallet update error:", walletErr.message);
      }
    }

    await createAdminNotification(
      payment.type === "note" ? "Note purchase verified" : "Subscription payment verified",
      `Payment ${payment._id} verified via client callback`,
      {
        paymentId: payment._id,
        regularClassId: payment.regularClassId,
        noteId: payment.noteId,
        gatewayPaymentId: paymentId,
        gatewayOrderId: orderId,
      }
    );

    return res.json({ success: true });
  } catch (err) {
    console.error("verifyPayment error", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

/**
 * GROUP BATCH: Verify payment and finalize enrollment idempotently
 * POST /api/payments/group/verify
 * Body: { orderId, paymentId, signature, batchId }
 * Ensures: signature valid, Payment(type="group") updated, hold finalized, student enrolled
 */
exports.verifyGroupPayment = async (req, res) => {
  try {
    const { orderId, paymentId, signature, batchId } = req.body;
    const userId = req.user.id;
    const StudentProfile = require("../models/StudentProfile");
    const sp = await StudentProfile.findOne({ userId }).select("_id");
    if (!sp) {
      return res.status(404).json({ success: false, message: "Student profile not found" });
    }
    if (!orderId || !paymentId || !signature) {
      return res.status(400).json({ success: false, message: "orderId, paymentId, signature are required" });
    }
    const secret = process.env.RAZORPAY_KEY_SECRET;
    if (!secret) {
      return res.status(500).json({ success: false, message: "Razorpay secret not configured" });
    }
    const expected = crypto.createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");
    if (expected !== signature) return res.status(400).json({ success: false, message: "Invalid signature" });

    const payment = await Payment.findOne({ gatewayOrderId: orderId, type: "group" });
    if (!payment) return res.status(404).json({ success: false, message: "Payment not found" });

    // Authorization: ensure the payment belongs to the logged-in student
    if (String(payment.studentId) !== String(sp._id)) {
      return res.status(403).json({ success: false, message: "Payment does not belong to this student" });
    }

    // Optional safety: ensure provided batchId (if any) matches payment record
    if (batchId && String(payment.groupBatchId) !== String(batchId)) {
      return res.status(400).json({ success: false, message: "Batch mismatch" });
    }

    // Idempotency: if already paid, return success
    if (payment.status === "paid") return res.json({ success: true });

    payment.status = "paid";
    payment.gatewayPaymentId = paymentId;
    await payment.save();

    const gb = await GroupBatch.findById(payment.groupBatchId);
    if (!gb) return res.status(404).json({ success: false, message: "Batch not found" });

    const now = Date.now();
    const holdIdx = (gb.holds || []).findIndex((h) => String(h.studentId) === String(payment.studentId || sp._id) && h.status === "active" && new Date(h.expiresAt).getTime() > now);
    
    const isEnrolled = gb.enrolled && gb.enrolled.some(id => String(id) === String(sp._id));
    if (holdIdx === -1 && !isEnrolled) return res.status(409).json({ success: false, message: "Seat hold missing or expired" });

    if (holdIdx !== -1) gb.holds[holdIdx].status = "finalized";
    
    gb.enrollmentDetails = gb.enrollmentDetails || [];
    const existingIdx = gb.enrollmentDetails.findIndex(e => String(e.studentId) === String(sp._id));
    
    // Use payment.periodEnd which was set during createGroupOrder
    const validUntil = payment.periodEnd || gb.batchEndDate || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    if (existingIdx !== -1) {
        gb.enrollmentDetails[existingIdx].validUntil = validUntil;
    } else {
        gb.enrollmentDetails.push({
            studentId: sp._id,
            validUntil: validUntil,
            joinedAt: new Date()
        });
    }

    gb.enrolled = gb.enrolled || [];
    if (!gb.enrolled.find((s) => String(s) === String(sp._id))) gb.enrolled.push(sp._id);
    await gb.save();

    await createAdminNotification(
      "Group batch payment verified",
      `Payment ${payment._id} verified and enrollment finalized`,
      { paymentId: payment._id, batchId: gb._id, studentId: sp._id }
    );
    try {
      const notificationService = require("../services/notificationService");
      const tp = await TutorProfile.findById(gb.tutorId).select("userId");
      if (tp?.userId) {
        await notificationService.createInApp(
          tp.userId,
          "New student enrolled",
          "A student has joined your group batch",
          { batchId: gb._id, studentId: sp._id }
        );
      }
    } catch (_) {}
    const metrics = require("../services/metricsService");
    metrics.incrementConversion(gb._id);
    metrics.incrementFill(gb._id);

    try {
      if (!payment.walletProcessed) {
        const amount = Number(payment.amount || 0);
        const commissionPercent = 25;
        const commissionAmount = (amount * commissionPercent) / 100;
        const tutorNetAmount = amount - commissionAmount;

        await walletService.adminCredit(amount, "Group batch payment verified", { type: "group", id: gb._id });
        await walletService.adminIncreaseHold(tutorNetAmount);

        const tp2 = await TutorProfile.findById(gb.tutorId).select("userId name");
        const sp2 = await StudentProfile.findById(sp._id).select("userId name");
        const tutorUserId = tp2?.userId || gb.tutorId;
        const studentUserId = sp2?.userId;
        await walletService.creditPending(
          tutorUserId,
          "tutor",
          tutorNetAmount,
          `Payment received for group batch (locked) — Student: ${sp2?.name || "Student"}`,
          { type: "group", id: gb._id }
        );
        const noteStr2 = String(payment.notes || "");
        const cm2 = noteStr2.match(/Coupon:([^,]*)/);
        const dm2 = noteStr2.match(/Discount:(\d+)/);
        const code2 = cm2 && cm2[1] ? cm2[1].trim() : "";
        const disc2 = dm2 && dm2[1] ? Number(dm2[1]) : 0;
        const descExtraGroup = disc2 > 0 && code2 ? ` (Coupon ${code2} -₹${disc2})` : "";
        await walletService.addTransaction({
          userId: studentUserId,
          type: "debit",
          amount,
          description: `Payment for group batch — Tutor: ${tp2?.name || "Tutor"}${descExtraGroup}`,
          reference: { type: "group", id: gb._id },
          status: "completed",
          paymentId: payment._id,
        });

        const baseDate = new Date();
        scheduleFundRelease(payment, baseDate);
        payment.walletProcessed = true;
        await payment.save();

        try {
          const notificationService = require("../services/notificationService");
          await notificationService.notifyUser(
            studentUserId,
            "Payment Verified",
            `Payment verified for your group batch enrolment`,
            { paymentId: payment._id, groupBatchId: gb._id }
          );
          await notificationService.notifyUser(
            tutorUserId,
            "Payment Locked",
            `A group batch payment was received and locked for release`,
            { paymentId: payment._id, groupBatchId: gb._id }
          );
        } catch (_) {}
      }
      // Record coupon and grant referral
      try {
        const studentUserIdX = sp2?.userId || req.user?.id;
        const noteStr = String(payment.notes || "");
        const cMatch = noteStr.match(/Coupon:([^,]*)/);
        const dMatch = noteStr.match(/Discount:(\d+)/);
        const code = cMatch && cMatch[1] ? cMatch[1].trim() : "";
        const disc = dMatch && dMatch[1] ? Number(dMatch[1]) : 0;
        if (code && studentUserIdX) {
          const coupon = await Coupon.findOne({ code });
          await recordCouponUse({ coupon, userId: studentUserIdX, paymentId: payment._id, amountDiscounted: disc });
        }
        if (studentUserIdX) {
          await grantReferralIfEligible({ studentUserId: studentUserIdX, paymentId: payment._id, amount });
        }
      } catch (_) {}
    } catch (walletErr) {
      console.error("Wallet update error:", walletErr.message);
    }

    return res.json({ success: true });
  } catch (err) {
    console.error("verifyGroupPayment error", err);
    try {
      const { orderId, batchId } = req.body || {};
      const payment = await Payment.findOne({ gatewayOrderId: orderId, type: "group" });
      if (payment) {
        payment.status = "failed";
        await payment.save();
      }
      if (batchId) {
        const userId = req.user?.id;
        const StudentProfile = require("../models/StudentProfile");
        const sp = await StudentProfile.findOne({ userId }).select("_id");
        const gb = await GroupBatch.findById(batchId);
        if (gb && sp) {
          gb.holds = (gb.holds || []).map((h) => {
            if (String(h.studentId) === String(sp._id) && h.status === "active") h.status = "released";
            return h;
          });
          const next = (gb.waitlist || []).shift();
          if (next) {
            const ttlMin = Number(process.env.GROUP_SEAT_HOLD_TTL_MIN || 15);
            const expires = new Date(Date.now() + ttlMin * 60 * 1000);
            gb.holds.push({ studentId: next, expiresAt: expires, status: "active" });
          }
          await gb.save();
        }
      }
    } catch (_) {}
    return res.status(500).json({ success: false, message: "Server error" });
  }
};



/**
 * Admin: generate payout records once month is over
 * GET /api/admin/payouts/generate?periodStart=YYYY-MM-DD&periodEnd=YYYY-MM-DD
 */
exports.generateTutorPayouts = async (req, res) => {
  try {
    const { periodStart, periodEnd } = req.query;
    const start = new Date(periodStart);
    const end = new Date(periodEnd);

    const subs = await Payment.find({
      type: "subscription",
      status: "paid",
      periodStart: { $gte: start },
      periodEnd: { $lte: end },
    });

    const payouts = [];

    for (const sub of subs) {
      const commissionPercent = 25;
      const commissionAmount = (sub.amount * commissionPercent) / 100;
      const tutorNetAmount = sub.amount - commissionAmount;

      const payout = await Payment.create({
        regularClassId: sub.regularClassId,
        studentId: sub.studentId,
        tutorId: sub.tutorId,
        type: "payout",
        amount: sub.amount,
        currency: sub.currency,
        commissionPercent,
        commissionAmount,
        tutorNetAmount,
        periodStart: sub.periodStart,
        periodEnd: sub.periodEnd,
        status: "created", // Admin will mark as "settled" after sending money
        notes: "Monthly payout generated",
      });

      payouts.push(payout);
    }

    await createAdminNotification(
      "Monthly tutor payouts generated",
      `Generated ${payouts.length} payout records`,
      { periodStart, periodEnd }
    );

    res.json({
      success: true,
      data: payouts,
    });
  } catch (err) {
    console.error("generateTutorPayouts error:", err);
    res
      .status(500)
      .json({ success: false, message: "Server error", error: err.message });
  }
};

exports.listNotePayments = async (req, res) => {
  try {
    const { status, from, to } = req.query;
    const filter = { type: "note" };
    if (status) filter.status = status;
    if (from || to) {
      filter.createdAt = {};
      if (from) filter.createdAt.$gte = new Date(from);
      if (to) filter.createdAt.$lte = new Date(to);
    }

    const items = await Payment.find(filter)
      .sort({ createdAt: -1 })
      .populate({ path: "studentId", select: "name" })
      .populate({ path: "tutorId", select: "name" })
      .populate({ path: "noteId", select: "title" })
      .lean();

    const data = items.map((p) => ({
      _id: p._id,
      type: p.type,
      amount: p.amount,
      currency: p.currency,
      status: p.status,
      gateway: p.gateway,
      gatewayOrderId: p.gatewayOrderId,
      gatewayPaymentId: p.gatewayPaymentId,
      createdAt: p.createdAt,
      studentName: p.studentId?.name || "Student",
      tutorName: p.tutorId?.name || "Tutor",
      noteId: p.noteId?._id || p.noteId,
      noteTitle: p.noteId?.title || "",
    }));

    res.json({ success: true, data });
  } catch (err) {
    console.error('listAllPaymentsHistory error:', err);
    res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

exports.getTutorNoteRevenue = async (req, res) => {
  try {
    const tutorId = req.user.id;
    const paidNotes = await Payment.find({ type: "note", status: "paid", tutorId: tutorId }).lean();
    const total = paidNotes.reduce((sum, p) => sum + Number(p.amount || 0), 0);
    const count = paidNotes.length;
    res.json({ success: true, data: { total, count } });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

// Tutor: list note payments (sales) with student names and note titles
exports.getTutorNoteHistory = async (req, res) => {
  try {
    const { from, to } = req.query;
    const userId = req.user.id;
    const TutorProfile = require("../models/TutorProfile");
    const tp = await TutorProfile.findOne({ userId }).select("_id");
    if (!tp) return res.status(404).json({ success: false, message: "Tutor profile not found" });

    const filter = { type: "note", tutorId: tp._id };
    if (from || to) {
      filter.createdAt = {};
      if (from) filter.createdAt.$gte = new Date(from);
      if (to) filter.createdAt.$lte = new Date(to);
    }

    const items = await Payment.find(filter)
      .sort({ createdAt: -1 })
      .populate({ path: "studentId", select: "name" })
      .populate({ path: "noteId", select: "title" })
      .lean();

    const data = items.map((p) => ({
      _id: p._id,
      amount: p.amount,
      currency: p.currency,
      status: p.status,
      createdAt: p.createdAt,
      studentName: p.studentId?.name || "Student",
      noteId: p.noteId?._id || p.noteId,
      noteTitle: p.noteId?.title || "",
    }));

    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

// Admin: combined payment history (subscription + note + group + payout) with pagination & filters
const BASE_REVENUE_STATUSES = ["paid", "settled"];

const buildPaymentDateFilter = ({ from, to }) => {
  const q = {};
  if (from || to) {
    q.createdAt = {};
    if (from) q.createdAt.$gte = new Date(from);
    if (to) q.createdAt.$lte = new Date(to);
  }
  return q;
};

const computeAdminAmount = (payment) => {
  const srcAmount = Number(payment.amount || 0);
  if (!srcAmount) return 0;
  if (["subscription", "note", "group"].includes(payment.type)) {
    if (typeof payment.commissionAmount === "number") {
      return Math.round(payment.commissionAmount);
    }
    return Math.round((srcAmount * 25) / 100);
  }
  return 0;
};

exports.listAllPaymentsHistory = async (req, res) => {
  try {
    const { from, to, status, type, page = 1, limit = 50, student, tutor } = req.query;
    const pageNum = Math.max(1, Number(page));
    const limitNum = Math.max(1, Number(limit));

    const paymentStatusFilter = status ? status : { $in: BASE_REVENUE_STATUSES };
    const baseRange = (q = {}) => {
      const filter = { ...q, ...buildPaymentDateFilter({ from, to }) };
      filter.status = paymentStatusFilter;
      return filter;
    };

    const include = (t) => !type || type === t;

    const subs = include("subscription")
      ? await Payment.find(baseRange({ type: "subscription" }))
          .sort({ createdAt: -1 })
          .populate({ path: "studentId", select: "name" })
          .populate({ path: "tutorId", select: "name" })
          .populate({ path: "regularClassId", select: "subject planType classCount" })
          .lean()
      : [];

    const notes = include("note")
      ? await Payment.find(baseRange({ type: "note" }))
          .sort({ createdAt: -1 })
          .populate({ path: "studentId", select: "name" })
          .populate({ path: "tutorId", select: "name" })
          .populate({ path: "noteId", select: "title" })
          .lean()
      : [];

    const groups = include("group")
      ? await Payment.find(baseRange({ type: "group" }))
          .sort({ createdAt: -1 })
          .populate({ path: "studentId", select: "name" })
          .populate({ path: "tutorId", select: "name" })
          .populate({ path: "groupBatchId", select: "subject level" })
          .lean()
      : [];

    const payouts = include("payout")
      ? await Payment.find(baseRange({ type: "payout" }))
          .sort({ createdAt: -1 })
          .populate({ path: "studentId", select: "name" })
          .populate({ path: "tutorId", select: "name upiId" })
          .lean()
      : [];

    // Referral transactions (credits to referrer or referred student)
    const Transaction = require("../models/Transaction");
    const refTxs = include("referral")
      ? await Transaction.find({
          ...buildPaymentDateFilter({ from, to }),
          'reference.type': 'referral'
        })
          .sort({ createdAt: -1 })
          .populate({ path: 'userId', select: 'role' })
          .lean()
      : [];

    // Names for referral rows
    const userIds = refTxs.map(t => String(t.userId?._id || t.userId));
    const StudentProfile = require("../models/StudentProfile");
    const TutorProfile = require("../models/TutorProfile");
    const sps = userIds.length ? await StudentProfile.find({ userId: { $in: userIds } }).select("userId name").lean() : [];
    const tps = userIds.length ? await TutorProfile.find({ userId: { $in: userIds } }).select("userId name").lean() : [];
    const spName = sps.reduce((acc, s) => { acc[String(s.userId)] = s.name || 'Student'; return acc; }, {});
    const tpName = tps.reduce((acc, t) => { acc[String(t.userId)] = t.name || 'Tutor'; return acc; }, {});

    // Referral code enrichment (if available)
    const ReferralUseModel = require("../models/ReferralUse");
    const refUses = userIds.length
      ? await ReferralUseModel.find(from || to ? { createdAt: { ...(from ? { $gte: new Date(from) } : {}), ...(to ? { $lte: new Date(to) } : {}) } } : {})
          .populate({ path: 'referralCodeId', select: 'code' })
          .lean()
      : [];
    const byReferrer = refUses.reduce((acc, ru) => { acc[String(ru.referrerUserId)] = ru; return acc; }, {});
    const byReferred = refUses.reduce((acc, ru) => { acc[String(ru.referredUserId)] = ru; return acc; }, {});

    const allPayments = [...subs, ...notes, ...groups];
    const allIds = allPayments.map((p) => p._id);
    const CouponUse = require("../models/CouponUse");
    const coupons = allIds.length ? await CouponUse.find({ paymentId: { $in: allIds } }).populate({ path: "couponId", select: "code value type" }).lean() : [];
    const referrals = allIds.length ? await ReferralUseModel.find({ paymentId: { $in: allIds } }).populate({ path: "referralCodeId", select: "code" }).lean() : [];
    const cuMap = coupons.reduce((acc, c) => { acc[String(c.paymentId)] = c; return acc; }, {});
    const ruMap = referrals.reduce((acc, r) => { acc[String(r.paymentId)] = r; return acc; }, {});

    const parseNotes = (n) => {
      const s = String(n || "");
      const cm = s.match(/Coupon:([^,]*)/);
      const dm = s.match(/Discount:(\d+)/);
      return { couponCode: cm && cm[1] ? cm[1].trim() : "", couponDiscount: dm && dm[1] ? Number(dm[1]) : 0 };
    };

    const toRow = (p, extra = {}) => {
      const tutorNet = p.tutorNetAmount ?? Math.max(0, Number(p.amount || 0) - Number(p.commissionAmount || 0));
      const releaseStatus = p.fundReleaseStatus || "pending";
      const pendingReleaseAmount = releaseStatus !== "released" ? tutorNet : 0;
      const adminAmount = computeAdminAmount(p);
      return {
        _id: p._id,
        type: p.type,
        amount: p.amount,
        currency: p.currency,
        status: p.status,
        gateway: p.gateway,
        gatewayOrderId: p.gatewayOrderId,
        gatewayPaymentId: p.gatewayPaymentId,
        createdAt: p.createdAt,
        studentName: p.studentId?.name || "Student",
        tutorName: p.tutorId?.name || "Tutor",
        adminAmount,
        couponCode: (cuMap[String(p._id)]?.couponId?.code) || parseNotes(p.notes).couponCode || "",
        couponDiscount: (cuMap[String(p._id)]?.amountDiscounted) ?? parseNotes(p.notes).couponDiscount ?? 0,
        referralCode: ruMap[String(p._id)]?.referralCodeId?.code || "",
        referralAmount: ruMap[String(p._id)]?.amountGranted || 0,
        referralRewardGranted: Boolean(ruMap[String(p._id)]?.rewardGranted),
        tutorNetAmount: tutorNet,
        fundReleaseStatus: releaseStatus,
        fundReleaseDate: p.fundReleaseDate,
        fundReleasedAt: p.fundReleasedAt,
        pendingReleaseAmount,
        ...extra,
      };
    };

    let mapSub = subs.map((p) => toRow(p, {
      subject: p.regularClassId?.subject || "",
      planType: p.regularClassId?.planType || "",
      classCount: p.regularClassId?.classCount || null,
    }));
    let mapNote = notes.map((p) => toRow(p, { noteTitle: p.noteId?.title || "" }));
    let mapGroup = groups.map((p) => toRow(p, { subject: p.groupBatchId?.subject || "" }));
    let mapPayout = payouts.map((p) => toRow(p, {
      amount: p.tutorNetAmount ?? Math.max(0, Number(p.amount || 0) - Number(p.commissionAmount || 0)),
      payoutUpi: p.tutorId?.upiId || null,
    }));

    // Build referral rows
    let mapReferral = refTxs.map((t) => ({
      _id: t._id,
      type: 'referral',
      amount: t.amount,
      currency: 'INR',
      status: t.status,
      gateway: '',
      gatewayOrderId: '',
      gatewayPaymentId: '',
      createdAt: t.createdAt,
      studentName: (t.userId?.role === 'student') ? (spName[String(t.userId?._id || t.userId)] || 'Student') : '—',
      tutorName: (t.userId?.role === 'tutor') ? (tpName[String(t.userId?._id || t.userId)] || 'Tutor') : '—',
      couponCode: '',
      couponDiscount: 0,
      referralCode: (byReferrer[String(t.userId?._id || t.userId)]?.referralCodeId?.code) || (byReferred[String(t.userId?._id || t.userId)]?.referralCodeId?.code) || '',
      referralAmount: t.amount,
      referralRewardGranted: t.status === 'completed',
      adminAmount: 0,
      fundReleaseStatus: 'released',
      fundReleaseDate: t.createdAt,
      fundReleasedAt: t.createdAt,
      pendingReleaseAmount: 0,
    }));

    const nameMatch = (n, q) => (q ? String(n || "").toLowerCase().includes(String(q).toLowerCase()) : true);
    if (student) {
      mapSub = mapSub.filter((r) => nameMatch(r.studentName, student));
      mapNote = mapNote.filter((r) => nameMatch(r.studentName, student));
      mapGroup = mapGroup.filter((r) => nameMatch(r.studentName, student));
      mapPayout = mapPayout.filter((r) => nameMatch(r.studentName, student));
      mapReferral = mapReferral.filter((r) => nameMatch(r.studentName, student));
    }
    if (tutor) {
      mapSub = mapSub.filter((r) => nameMatch(r.tutorName, tutor));
      mapNote = mapNote.filter((r) => nameMatch(r.tutorName, tutor));
      mapGroup = mapGroup.filter((r) => nameMatch(r.tutorName, tutor));
      mapPayout = mapPayout.filter((r) => nameMatch(r.tutorName, tutor));
      mapReferral = mapReferral.filter((r) => nameMatch(r.tutorName, tutor));
    }

    const combinedAll = [...mapSub, ...mapNote, ...mapGroup, ...mapPayout, ...mapReferral].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    if (type === 'referral') {
      console.log('Admin history referral count:', mapReferral.length, 'from', refTxs.length);
    }
    const total = combinedAll.length;
    const start = (pageNum - 1) * limitNum;
    const data = combinedAll.slice(start, start + limitNum);

    res.json({ success: true, data, pagination: { total, page: pageNum, limit: limitNum, pages: Math.ceil(total / limitNum) } });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

/**
 * Admin: mark payout as settled after sending to tutor
 * PATCH /api/admin/payouts/:id/settle
 */
exports.settlePayout = async (req, res) => {
  try {
    const payoutId = req.params.id;
    const payout = await Payment.findById(payoutId);
    if (!payout || payout.type !== "payout") {
      return res
        .status(404)
        .json({ success: false, message: "Payout not found" });
    }

    payout.status = "settled";
    await payout.save();

    await createAdminNotification(
      "Tutor payout settled",
      `Payout ${payout._id} marked as settled`,
      { payoutId }
    );

    res.json({ success: true, data: payout });
  } catch (err) {
    console.error("settlePayout error:", err);
    res
      .status(500)
      .json({ success: false, message: "Server error", error: err.message });
  }
};

/**
 * Admin: list tutor payouts
 * GET /api/payments/admin/payouts?status=created|settled&from=YYYY-MM-DD&to=YYYY-MM-DD
 */
exports.listTutorPayouts = async (req, res) => {
  try {
    const { status, from, to } = req.query;
    const filter = { type: "payout" };
    if (status) filter.status = status;
    if (from || to) {
      filter.createdAt = {};
      if (from) filter.createdAt.$gte = new Date(from);
      if (to) filter.createdAt.$lte = new Date(to);
    }

    const payouts = await Payment.find(filter)
      .sort({ createdAt: -1 })
      .populate({ path: "tutorId", select: "name upiId accountHolderName bankAccountNumber ifsc" })
      .lean();

    const data = payouts.map((p) => ({
      _id: p._id,
      tutorId: p.tutorId?._id || p.tutorId,
      tutorName: p.tutorId?.name || "Tutor",
      amount: p.amount,
      commissionAmount: p.commissionAmount,
      tutorNetAmount: p.tutorNetAmount ?? Math.max(0, Number(p.amount || 0) - Number(p.commissionAmount || 0)),
      periodStart: p.periodStart,
      periodEnd: p.periodEnd,
      status: p.status,
      upi: p.tutorId?.upiId || null,
      bank: p.tutorId?.bankAccountNumber ? {
        accountHolderName: p.tutorId?.accountHolderName || null,
        bankAccountNumber: p.tutorId?.bankAccountNumber || null,
        ifsc: p.tutorId?.ifsc || null,
      } : null,
    }));

    res.json({ success: true, data });
  } catch (err) {
    console.error("listTutorPayouts error:", err);
    res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

exports.createRefundRequest = async (req, res) => {
  try {
    const { paymentId, reasonCode, reasonText, amount } = req.body;
    const userId = req.user.id;
    if (!paymentId) {
      return res.status(400).json({ success: false, message: "paymentId is required" });
    }
    if (typeof amount !== "undefined") {
      return res.status(400).json({ success: false, message: "Amount must not be provided by student" });
    }
    const payment = await Payment.findById(paymentId);
    if (!payment) {
      return res.status(404).json({ success: false, message: "Payment not found" });
    }
    // Authorization: support either StudentProfile._id held in payment.studentId OR direct User._id
    try {
      const StudentProfile = require("../models/StudentProfile");
      const sp = await StudentProfile.findById(payment.studentId).select("userId");
      const ownerUserId = sp?.userId || payment.studentId;
      if (String(ownerUserId) !== String(userId)) {
        return res.status(403).json({ success: false, message: "Not authorized for this payment" });
      }
    } catch (_) {
      // Fallback: compare directly when studentId stores User._id
      if (String(payment.studentId) !== String(userId)) {
        return res.status(403).json({ success: false, message: "Not authorized for this payment" });
      }
    }
    if (!['subscription', 'note', 'group'].includes(payment.type) || payment.status !== 'paid') {
      return res.status(400).json({ success: false, message: "Refunds allowed for paid subscription/note/group payments" });
    }
    const now = new Date();
    if (payment.createdAt && (now.getTime() - new Date(payment.createdAt).getTime()) > 30 * 24 * 60 * 60 * 1000) {
      return res.status(400).json({ success: false, message: "Refund window expired" });
    }
    if (!reasonCode || !["CLASS_NOT_CONDUCTED","TUTOR_ABSENT_OR_LATE","WRONG_PURCHASE","QUALITY_ISSUE","TECHNICAL_ISSUE","SCHEDULE_CONFLICT","CONTENT_NOT_AS_DESCRIBED","OTHER"].includes(reasonCode)) {
      return res.status(400).json({ success: false, message: "Invalid reasonCode" });
    }
    if (reasonCode === "OTHER" && !(reasonText && String(reasonText).trim().length > 0)) {
      return res.status(400).json({ success: false, message: "reasonText is required for OTHER" });
    }
    let ctx = await getRefundContext(paymentId);
    ctx = applyReasonModifier(ctx, reasonCode);
    const suggestedAmount = Math.max(0, Number(ctx.remainingRefundable || 0));
    const RefundRequest = require("../models/RefundRequest");
    const rr = await RefundRequest.create({
      paymentId,
      userId,
      amount: Number(suggestedAmount),
      reason: reasonText || "",
      reasonCode,
      reasonText: reasonText || null,
      completionPercentage: Number(ctx.completionPercentage || 0),
      refundableCap: Number(ctx.refundableCap || 0),
      suggestedAmount: Number(suggestedAmount)
    });
    let courseLabel = null;
    let studentName = null;
    let tutorName = null;
    const type = payment.type || null;
    if (type === "subscription" && payment.regularClassId) {
      const RegularClass = require("../models/RegularClass");
      const rc = await RegularClass.findById(payment.regularClassId)
        .select("subject studentId tutorId")
        .populate([{ path: "studentId", select: "name" }, { path: "tutorId", select: "name" }]);
      courseLabel = rc?.subject || null;
      studentName = rc?.studentId?.name || null;
      tutorName = rc?.tutorId?.name || null;
      if (!tutorName && rc?.tutorId) {
        try {
          const TutorProfile = require("../models/TutorProfile");
          const tid = typeof rc.tutorId === "object" ? rc.tutorId._id || rc.tutorId : rc.tutorId;
          const tp = tid ? await TutorProfile.findById(tid).select("name") : null;
          tutorName = tp?.name || tutorName;
        } catch (_) {}
      }
      if (!tutorName) {
        try {
          const Session = require("../models/Session");
          const latest = await Session.findOne({ regularClassId: payment.regularClassId })
            .sort({ startDateTime: -1 })
            .select("tutorId");
          if (latest?.tutorId) {
            const TutorProfile = require("../models/TutorProfile");
            const tp = await TutorProfile.findById(latest.tutorId).select("name");
            tutorName = tp?.name || tutorName;
          }
        } catch (_) {}
      }
    } else if (type === "group" && payment.groupBatchId) {
      const GroupBatch = require("../models/GroupBatch");
      const gb = await GroupBatch.findById(payment.groupBatchId)
        .select("subject tutorId")
        .populate([{ path: "tutorId", select: "name" }]);
      courseLabel = gb?.subject || null;
      tutorName = gb?.tutorId?.name || null;
    } else if (type === "note" && payment.noteId) {
      const Note = require("../models/Note");
      const note = await Note.findById(payment.noteId)
        .select("title subject tutorId")
        .populate([{ path: "tutorId", select: "name" }]);
      courseLabel = note?.title || note?.subject || null;
      tutorName = note?.tutorId?.name || null;
    }
    if (!studentName && payment.studentId) {
      try {
        const StudentProfile = require("../models/StudentProfile");
        const sp2 = await StudentProfile.findById(payment.studentId).select("name");
        studentName = sp2?.name || null;
      } catch (_) {}
    }
    if (!tutorName && payment.tutorId) {
      try {
        const TutorProfile = require("../models/TutorProfile");
        const tp2 = await TutorProfile.findById(payment.tutorId).select("name");
        tutorName = tp2?.name || null;
      } catch (_) {}
    }
    if (!studentName) {
      try {
        const StudentProfile = require("../models/StudentProfile");
        const sp3 = await StudentProfile.findOne({ userId }).select("name");
        studentName = sp3?.name || null;
      } catch (_) {}
    }
    return res.status(201).json({
      success: true,
      data: {
        ...rr.toObject(),
        paymentType: type,
        paymentAmount: payment.amount || 0,
        paymentGateway: payment.gateway || null,
        courseLabel,
        studentName,
        tutorName,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

exports.listRefundRequests = async (req, res) => {
  try {
    const { status, from, to, page = 1, limit = 50 } = req.query;
    const RefundRequest = require("../models/RefundRequest");
    const filter = {};
    if (status) filter.status = status;
    if (from || to) {
      filter.createdAt = {};
      if (from) filter.createdAt.$gte = new Date(from);
      if (to) filter.createdAt.$lte = new Date(to);
    }
    const skip = Math.max(0, (Number(page) - 1) * Number(limit));
    const items = await RefundRequest.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit))
      .populate({
        path: "paymentId",
        select: "type amount currency gateway tutorId studentId regularClassId groupBatchId noteId",
        populate: [
          { path: "tutorId", select: "name userId" },
          { path: "studentId", select: "name userId" },
          {
            path: "regularClassId",
            select: "subject studentId tutorId",
            populate: [
              { path: "studentId", select: "name" },
              { path: "tutorId", select: "name" }
            ]
          },
          {
            path: "groupBatchId",
            select: "subject tutorId",
            populate: [{ path: "tutorId", select: "name" }]
          },
          {
            path: "noteId",
            select: "title subject tutorId",
            populate: [{ path: "tutorId", select: "name" }]
          },
        ],
      })
      .populate({ path: "userId", select: "name role" })
      .lean();
    const data = await Promise.all(items.map(async (r) => {
      const type = r.paymentId?.type || null;
      let courseLabel = null;
      if (type === "subscription" && r.paymentId?.regularClassId) {
        courseLabel = r.paymentId?.regularClassId?.subject || null;
      } else if (type === "group" && r.paymentId?.groupBatchId) {
        courseLabel = r.paymentId?.groupBatchId?.subject || null;
      } else if (type === "note" && r.paymentId?.noteId) {
        courseLabel = r.paymentId?.noteId?.title || r.paymentId?.noteId?.subject || null;
      }
      let studentName = null;
      let tutorName = null;
      studentName =
        r.paymentId?.studentId?.name ||
        (type === "subscription" ? r.paymentId?.regularClassId?.studentId?.name : null) ||
        null;
      tutorName =
        r.paymentId?.tutorId?.name ||
        (type === "subscription" ? r.paymentId?.regularClassId?.tutorId?.name : null) ||
        (type === "group" ? r.paymentId?.groupBatchId?.tutorId?.name : null) ||
        (type === "note" ? r.paymentId?.noteId?.tutorId?.name : null) ||
        null;
      if (!tutorName && type === "subscription" && r.paymentId?.regularClassId?.tutorId) {
        try {
          const TutorProfile = require("../models/TutorProfile");
          const tutorId =
            typeof r.paymentId.regularClassId.tutorId === "object"
              ? r.paymentId.regularClassId.tutorId._id || r.paymentId.regularClassId.tutorId
              : r.paymentId.regularClassId.tutorId;
          const tp = tutorId ? await TutorProfile.findById(tutorId).select("name") : null;
          tutorName = tp?.name || tutorName;
        } catch (_) {}
      }
      // Fallback: resolve student name via StudentProfile.userId
      if (!studentName && r.userId?._id) {
        try {
          const StudentProfile = require("../models/StudentProfile");
          const sp = await StudentProfile.findOne({ userId: r.userId._id }).select("name");
          studentName = sp?.name || null;
        } catch (_) {}
      }
      if (!tutorName && type === "subscription" && r.paymentId?.regularClassId) {
        try {
          const Session = require("../models/Session");
          const rcId = r.paymentId.regularClassId._id || r.paymentId.regularClassId;
          const latest = await Session.findOne({ regularClassId: rcId })
            .sort({ startDateTime: -1 })
            .select("tutorId");
          if (latest?.tutorId) {
            const TutorProfile = require("../models/TutorProfile");
            const tp = await TutorProfile.findById(latest.tutorId).select("name");
            tutorName = tp?.name || tutorName;
          }
        } catch (_) {}
      }
      return {
        ...r,
        paymentType: type,
        paymentAmount: r.paymentId?.amount || 0,
        paymentGateway: r.paymentId?.gateway || null,
        courseLabel,
        studentName,
        tutorName,
      };
    }));
    return res.json({ success: true, data });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

exports.updateRefundRequestStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, amountApproved, method, upiId, bankAccountNumber, accountHolderName, ifsc } = req.body;
    const RefundRequest = require("../models/RefundRequest");
    const rr = await RefundRequest.findById(id);
    if (!rr) return res.status(404).json({ success: false, message: "Refund request not found" });
    if (!['approved', 'rejected', 'processed'].includes(status)) {
      return res.status(400).json({ success: false, message: "Invalid status" });
    }
  if (status === 'approved') {
      const payment = await Payment.findById(rr.paymentId);
      if (!payment) return res.status(404).json({ success: false, message: "Payment not found" });
      if (!['subscription', 'note', 'group'].includes(payment.type) || payment.status !== 'paid') {
        return res.status(400).json({ success: false, message: "Refunds allowed for paid subscription/note/group payments" });
      }
      let ctx = await getRefundContext(rr.paymentId);
      const rc2 = rr.reasonCode || null;
      if (rc2) ctx = applyReasonModifier(ctx, rc2);
      const maxRemaining = Math.max(0, Number(ctx.remainingRefundable || 0));
      let approved = Number(amountApproved || rr.amount || 0);
      approved = Math.min(approved, maxRemaining);
      if (approved <= 0) {
        return res.status(400).json({ success: false, message: "No refundable amount remaining" });
      }
      rr.status = 'approved';
      rr.amountApproved = approved;
      rr.method = method || rr.method || (payment.gateway === 'wallet' ? 'payout' : 'provider');
      rr.adminUserId = req.user._id;
      await rr.save();

      try {
        const full = Math.max(0, Number(rr.amountApproved || 0) + Math.max(0, Number(payment.refundTotal || 0))) >= Math.max(0, Number(payment.amount || 0));
        if (full) {
          if (payment.type === 'subscription' && payment.regularClassId) {
            const RegularClass = require("../models/RegularClass");
            const rc = await RegularClass.findById(payment.regularClassId);
            if (rc) {
              rc.status = 'ended';
              await rc.save();
              const Session = require("../models/Session");
              await Session.deleteMany({ regularClassId: rc._id, status: 'scheduled' });
            }
          } else if (payment.type === 'group' && payment.groupBatchId) {
            const GroupBatch = require("../models/GroupBatch");
            const gb = await GroupBatch.findById(payment.groupBatchId);
            if (gb) {
              gb.enrolled = gb.enrolled.filter(s => String(s) !== String(payment.studentId));
              gb.enrollmentDetails = gb.enrollmentDetails.filter(e => String(e.studentId) !== String(payment.studentId));
              await gb.save();
            }
          }
        }
      } catch (accessErr) {}

      try {
        const notificationService = require("../services/notificationService");
        await notificationService.notifyUser(rr.userId, "Refund Approved", "Your refund was approved", { refundRequestId: rr._id, amountApproved: rr.amountApproved, method: rr.method });
      } catch (_) {}
      if (rr.method === 'provider') {
        if (payment.gateway !== 'razorpay') {
          return res.status(400).json({ success: false, message: "Provider refund requires Razorpay payment" });
        }
        if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
          rr.providerStatus = 'pending';
          await rr.save();
          return res.json({ success: true, data: rr, warning: "Razorpay not configured; refund marked approved and pending processing" });
        }
        const amtPaise = Math.round(Number(rr.amountApproved) * 100);
        const notes = { rr: String(rr._id) };
        const r = await razorpay.payments.refund(payment.gatewayPaymentId, { amount: amtPaise, notes });
        rr.providerRefundId = r.id;
        rr.providerStatus = r.status || 'initiated';
        await rr.save();
        try {
          await createAdminNotification("Provider refund initiated", "Refund to source via Razorpay", { refundRequestId: rr._id, paymentId: payment._id, amount: rr.amountApproved });
        } catch (_) {}
        return res.json({ success: true, data: rr });
      } else if (rr.method === 'payout') {
        if (!process.env.RAZORPAYX_KEY_ID || !process.env.RAZORPAYX_KEY_SECRET || !process.env.RAZORPAYX_ACCOUNT_NUMBER) {
          rr.providerStatus = 'pending';
          await rr.save();
          return res.json({ success: true, data: rr, warning: "RazorpayX not configured; refund marked approved and pending payout" });
        }
        const StudentProfile = require("../models/StudentProfile");
        const sp = await StudentProfile.findById(payment.studentId).select("name email");
        const stub = {
          _id: rr.userId,
          name: sp?.name || "Student",
          email: sp?.email || undefined,
          upiId: (upiId || "").trim(),
          accountHolderName: (accountHolderName || "").trim(),
          bankAccountNumber: (bankAccountNumber || "").trim(),
          ifsc: (ifsc || "").trim(),
          razorpayxContactId: null,
          razorpayxFundAccountId: null,
        };
        const { ensureContactAndFundAccount, createPayout } = require("../services/payments/payoutProvider");
        const { contactId, fundAccountId, useUPI } = await ensureContactAndFundAccount(stub);
        const mode = useUPI ? "UPI" : "IMPS";
        const p = await createPayout(fundAccountId, Number(rr.amountApproved), mode, String(rr._id));
        rr.providerRefundId = p.id;
        rr.providerStatus = p.status || 'initiated';
        await rr.save();
        const adminWalletService = require("../services/payments/walletService");
        await adminWalletService.adminDebit(Number(rr.amountApproved), "Refund payout", { type: "refund", id: rr._id });
        return res.json({ success: true, data: rr });
      } else {
        return res.status(400).json({ success: false, message: "Invalid method" });
      }
    }
    if (status === 'rejected') {
      rr.status = 'rejected';
      await rr.save();
      return res.json({ success: true, data: rr });
    }
    if (status === 'processed') {
      return res.status(405).json({ success: false, message: "Processing is driven by provider webhooks" });
    }
  } catch (err) {
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

exports.getStudentRegularClassPayment = async (req, res) => {
  try {
    const userId = req.user.id;
    const rcId = req.params.id;
    const RegularClass = require("../models/RegularClass");
    const rc = await RegularClass.findById(rcId);
    if (!rc) return res.status(404).json({ success: false, message: "Regular class not found" });
    try {
      const StudentProfile = require("../models/StudentProfile");
      const sp = await StudentProfile.findById(rc.studentId).select("userId");
      const ownerUserId = sp?.userId || rc.studentId;
      if (String(ownerUserId) !== String(userId)) {
        return res.status(403).json({ success: false, message: "Not authorized" });
      }
    } catch (_) {}
    let p = await Payment.findOne({ regularClassId: rcId, type: "subscription", status: "paid" }).sort({ createdAt: -1 }).lean();
    if (!p) {
      p = await Payment.findOne({ regularClassId: rcId, type: "subscription" }).sort({ createdAt: -1 }).lean();
    }
    if (!p) return res.json({ success: true, data: null });
    return res.json({
      success: true,
      data: {
        _id: p._id,
        amount: p.amount,
        currency: p.currency,
        status: p.status,
        gateway: p.gateway,
        gatewayOrderId: p.gatewayOrderId,
        regularClassId: p.regularClassId,
        createdAt: p.createdAt,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};
exports.listStudentRefunds = async (req, res) => {
  try {
    const userId = req.user.id;
    const RefundRequest = require("../models/RefundRequest");
    const items = await RefundRequest.find({ userId })
      .sort({ createdAt: -1 })
      .populate({
        path: "paymentId",
        select: "type amount currency gateway tutorId studentId regularClassId groupBatchId noteId",
        populate: [
          { path: "tutorId", select: "name" },
          {
            path: "regularClassId",
            select: "subject tutorId",
            populate: [{ path: "tutorId", select: "name" }],
          },
          {
            path: "groupBatchId",
            select: "subject tutorId",
            populate: [{ path: "tutorId", select: "name" }],
          },
          {
            path: "noteId",
            select: "title subject tutorId",
            populate: [{ path: "tutorId", select: "name" }],
          },
        ],
      })
      .lean();
    const data = items.map((r) => {
      const type = r.paymentId?.type || null;
      let courseLabel = null;
      if (type === "subscription" && r.paymentId?.regularClassId) {
        courseLabel = r.paymentId?.regularClassId?.subject || null;
      } else if (type === "group" && r.paymentId?.groupBatchId) {
        courseLabel = r.paymentId?.groupBatchId?.subject || null;
      } else if (type === "note" && r.paymentId?.noteId) {
        courseLabel = r.paymentId?.noteId?.title || r.paymentId?.noteId?.subject || null;
      }
      const tutorName =
        r.paymentId?.tutorId?.name ||
        (type === "subscription" ? r.paymentId?.regularClassId?.tutorId?.name : null) ||
        (type === "group" ? r.paymentId?.groupBatchId?.tutorId?.name : null) ||
        (type === "note" ? r.paymentId?.noteId?.tutorId?.name : null) ||
        null;
      return {
        ...r,
        paymentType: type,
        paymentAmount: r.paymentId?.amount || 0,
        paymentGateway: r.paymentId?.gateway || null,
        courseLabel,
        tutorName,
      };
    });
    return res.json({ success: true, data });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

exports.previewRefund = async (req, res) => {
  try {
    const { paymentId, reasonCode, reasonText } = req.body;
    if (!paymentId) {
      return res.status(400).json({ success: false, message: "paymentId is required" });
    }
    const payment = await Payment.findById(paymentId);
    if (!payment) {
      return res.status(404).json({ success: false, message: "Payment not found" });
    }
    let ctx = await getRefundContext(paymentId);
    if (reasonCode) {
      if (!["CLASS_NOT_CONDUCTED","TUTOR_ABSENT_OR_LATE","WRONG_PURCHASE","QUALITY_ISSUE","TECHNICAL_ISSUE","SCHEDULE_CONFLICT","CONTENT_NOT_AS_DESCRIBED","OTHER"].includes(reasonCode)) {
        return res.status(400).json({ success: false, message: "Invalid reasonCode" });
      }
      if (reasonCode === "OTHER" && !(reasonText && String(reasonText).trim().length > 0)) {
        return res.status(400).json({ success: false, message: "reasonText is required for OTHER" });
      }
      ctx = applyReasonModifier(ctx, reasonCode);
    }
    const suggestedRefundMethod = payment.gateway === "razorpay" ? "provider" : "payout";
    const explanation = `Completion ${(Math.round(ctx.completionPercentage * 100))}% → refundable ${(Math.round(ctx.refundablePercentage * 100))}%`;
    return res.json({
      success: true,
      data: {
        completionPercentage: ctx.completionPercentage,
        refundablePercentage: ctx.refundablePercentage,
        maximumRefundableAmount: Math.max(0, Number(ctx.remainingRefundable || 0)),
        explanation,
        refundWindowValid: ctx.refundWindowValid,
        suggestedRefundMethod
      }
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

/**
 * Admin: list subscription payments (student → admin)
 * GET /api/payments/admin/history?status=paid&from=YYYY-MM-DD&to=YYYY-MM-DD
 */
exports.listSubscriptionPayments = async (req, res) => {
  try {
    const { status, from, to } = req.query;
    const filter = { type: "subscription" };
    if (status) filter.status = status;
    if (from || to) {
      filter.createdAt = {};
      if (from) filter.createdAt.$gte = new Date(from);
      if (to) filter.createdAt.$lte = new Date(to);
    }

    const payments = await Payment.find(filter)
      .sort({ createdAt: -1 })
      .populate({ path: "studentId", select: "name" })
      .populate({ path: "tutorId", select: "name" })
      .populate({
        path: "regularClassId",
        select: "subject planType classCount studentId tutorId",
        populate: [
          { path: "studentId", select: "name" },
          { path: "tutorId", select: "name" }
        ]
      })
      .lean();

    const data = payments.map((p) => ({
      _id: p._id,
      amount: p.amount,
      currency: p.currency,
      status: p.status,
      gateway: p.gateway,
      gatewayOrderId: p.gatewayOrderId,
      gatewayPaymentId: p.gatewayPaymentId,
      createdAt: p.createdAt,
      studentName: p.studentId?.name || p.regularClassId?.studentId?.name || "Student",
      tutorName: p.tutorId?.name || p.regularClassId?.tutorId?.name || "Tutor",
      subject: p.regularClassId?.subject || "",
      planType: p.regularClassId?.planType || "",
      classCount: p.regularClassId?.classCount || null,
    }));

    res.json({ success: true, data });
  } catch (err) {
    console.error("listSubscriptionPayments error:", err);
    res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

exports.getTutorEarningsSummary = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const userId = req.user.id;
    const Transaction = require("../models/Transaction");
    const Wallet = require("../models/Wallet");

    const wallet = await Wallet.findOne({ userId });
    const filter = { userId, type: "credit" };
    if (startDate || endDate) {
      filter.createdAt = {};
      if (startDate) filter.createdAt.$gte = new Date(startDate);
      if (endDate) filter.createdAt.$lte = new Date(endDate);
    }

    const credits = await Transaction.find(filter).lean();
    const totalCredits = credits.reduce((sum, t) => sum + Number(t.amount || 0), 0);
    const bySource = credits.reduce((acc, t) => {
      const src = t.reference?.type || "unknown";
      acc[src] = (acc[src] || 0) + Number(t.amount || 0);
      return acc;
    }, {});

    res.json({
      success: true,
      data: {
        availableBalance: Number(wallet?.balance || 0),
        pendingBalance: Number(wallet?.pendingBalance || 0),
        totalCredits,
        bySource,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

exports.getAdminRevenueTimeseries = async (req, res) => {
  try {
    const { from, to } = req.query;
    const start = from ? new Date(from) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const end = to ? new Date(to) : new Date();
    const matchBase = { status: "paid", createdAt: { $gte: start, $lte: end } };
    const bucketFmt = { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } };
    const subs = await Payment.aggregate([
      { $match: { ...matchBase, type: "subscription" } },
      { $group: { _id: bucketFmt, total: { $sum: "$amount" }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]);
    const notes = await Payment.aggregate([
      { $match: { ...matchBase, type: "note" } },
      { $group: { _id: bucketFmt, total: { $sum: "$amount" }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]);
    const groups = await Payment.aggregate([
      { $match: { ...matchBase, type: "group" } },
      { $group: { _id: bucketFmt, total: { $sum: "$amount" }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]);
    // Referral totals from wallet transactions (credits for referral rewards/bonuses)
    const Transaction = require("../models/Transaction");
    const refs = await Transaction.aggregate([
      { $match: { status: { $in: ["completed", "locked"] }, createdAt: { $gte: start, $lte: end }, 'reference.type': 'referral' } },
      { $group: { _id: bucketFmt, total: { $sum: "$amount" }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]);
    const seriesDates = new Set([...
      subs.map((x) => x._id),
      ...notes.map((x) => x._id),
      ...groups.map((x) => x._id),
      ...refs.map((x) => x._id),
    ]);
    const commissionPercent = 25;
    const merged = Array.from(seriesDates).sort().map((d) => {
      const s = subs.find((x) => x._id === d);
      const n = notes.find((x) => x._id === d);
      const g = groups.find((x) => x._id === d);
      const subTotal = s?.total || 0;
      const noteTotal = n?.total || 0;
      const groupTotal = g?.total || 0;
      const refTotal = (refs.find((x) => x._id === d)?.total) || 0;
      const commissionTotal = Math.round(((subTotal + noteTotal + groupTotal) * commissionPercent) / 100);
      return {
        date: d,
        subscriptionTotal: subTotal,
        subscriptionCount: s?.count || 0,
        noteTotal,
        noteCount: n?.count || 0,
        groupTotal,
        groupCount: g?.count || 0,
        referralTotal: refTotal,
        referralCount: (refs.find((x) => x._id === d)?.count) || 0,
        commissionTotal,
      };
    });
    const refundAgg = await Payment.aggregate([
      { $match: { createdAt: { $gte: start, $lte: end }, refundTotal: { $gt: 0 } } },
      { $group: { _id: null, total: { $sum: "$refundTotal" } } },
    ]);
    const refundTotal = refundAgg?.[0]?.total || 0;
    const pendingReleaseAgg = await Payment.aggregate([
      { $match: { status: "paid", fundReleaseStatus: "pending" } },
      { $group: { _id: null, total: { $sum: "$tutorNetAmount" } } },
    ]);
    const pendingReleaseTotal = pendingReleaseAgg?.[0]?.total || 0;
    const totals = {
      subscriptionTotal: merged.reduce((sum, x) => sum + x.subscriptionTotal, 0),
      noteTotal: merged.reduce((sum, x) => sum + x.noteTotal, 0),
      groupTotal: merged.reduce((sum, x) => sum + (x.groupTotal || 0), 0),
      referralTotal: merged.reduce((sum, x) => sum + (x.referralTotal || 0), 0),
      commissionTotal: merged.reduce((sum, x) => sum + x.commissionTotal, 0),
      refundTotal,
      pendingReleaseTotal,
    };
    return res.json({ success: true, data: { series: merged, totals, period: { from: start, to: end } } });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

exports.requestTutorPayout = async (req, res) => {
  try {
    const { amount } = req.body;
    const userId = req.user.id;
    const MIN_PAYOUT = 10; // INR

    if (!amount || Number(amount) <= 0) {
      return res.status(400).json({ success: false, message: "Invalid amount" });
    }
    if (Number(amount) < MIN_PAYOUT) {
      return res.status(400).json({ success: false, message: `Minimum payout is ₹${MIN_PAYOUT}` });
    }

    const TutorProfile = require("../models/TutorProfile");
    let tp = await TutorProfile.findOne({ userId }).lean();
    if (!tp) return res.status(404).json({ success: false, message: "Tutor profile not found" });
    if (tp.kycStatus !== "approved") {
      return res.status(403).json({ success: false, message: "KYC not approved" });
    }
    let hasUPI = tp.upiId && tp.upiId.trim().length > 0;
    let hasBank = tp.bankAccountNumber && tp.ifsc && tp.accountHolderName;
    if (!hasUPI && !hasBank) {
      const { upiId, accountHolderName, bankAccountNumber, ifsc } = req.body || {};
      const nextUpdate = {};
      if (typeof upiId === "string" && upiId.trim().length > 0) {
        nextUpdate.upiId = upiId.trim();
      } else if (
        typeof accountHolderName === "string" &&
        accountHolderName.trim().length > 0 &&
        typeof bankAccountNumber === "string" &&
        bankAccountNumber.trim().length > 0 &&
        typeof ifsc === "string" &&
        ifsc.trim().length > 0
      ) {
        nextUpdate.accountHolderName = accountHolderName.trim();
        nextUpdate.bankAccountNumber = bankAccountNumber.trim();
        nextUpdate.ifsc = ifsc.trim();
      }
      if (Object.keys(nextUpdate).length > 0) {
        await TutorProfile.updateOne({ _id: tp._id }, { $set: nextUpdate });
        tp = await TutorProfile.findById(tp._id).lean();
        hasUPI = tp.upiId && tp.upiId.trim().length > 0;
        hasBank = tp.bankAccountNumber && tp.ifsc && tp.accountHolderName;
      }
      if (!hasUPI && !hasBank) {
        return res.status(400).json({ success: false, message: "No payout method (UPI/Bank) set" });
      }
    }

    const Payment = require("../models/Payment");
    const walletService = require("../services/payments/walletService");
    const { ensureContactAndFundAccount, createPayout } = require("../services/payments/payoutProvider");

    const currentWallet = await walletService.getWallet(userId);
    const availableBalance = Number(currentWallet?.balance || 0);
    const pendingBalance = Number(currentWallet?.pendingBalance || 0);
    if (availableBalance < Number(amount)) {
      return res.status(400).json({
        success: false,
        message: "Insufficient available balance",
        details: {
          availableBalance,
          pendingBalance,
          requestedAmount: Number(amount),
        },
      });
    }

    const payout = await Payment.create({
      tutorId: tp._id,
      type: "payout",
      amount: Number(amount),
      currency: "INR",
      commissionPercent: 0,
      commissionAmount: 0,
      tutorNetAmount: Number(amount),
      status: "created",
      notes: hasUPI ? `Tutor withdrawal request (UPI)` : `Tutor withdrawal request (Bank)`,
    });

    try {
      await walletService.debitWalletGeneric(
        userId,
        "tutor",
        Number(amount),
        "Payout requested",
        { type: "payout", id: payout._id }
      );
    } catch (debitErr) {
      await Payment.updateOne({ _id: payout._id }, { status: "failed", notes: "Debit failed: insufficient funds" });
      return res.status(400).json({
        success: false,
        message: "Unable to reserve funds for payout",
        error: debitErr.message || "Debit failed",
        details: { availableBalance, pendingBalance, requestedAmount: Number(amount) },
      });
    }

    const TutorProfileModel = require("../models/TutorProfile");
    const hasKeys =
      process.env.RAZORPAYX_KEY_ID &&
      process.env.RAZORPAYX_KEY_SECRET &&
      process.env.RAZORPAYX_ACCOUNT_NUMBER;
    try {
      if (!hasKeys) {
        payout.status = "created";
        await payout.save();
        return res.json({ success: true, data: { payoutId: payout._id, mode: "offline" } });
      }
      const { contactId, fundAccountId, useUPI } = await ensureContactAndFundAccount(tp);
      await TutorProfileModel.updateOne(
        { _id: tp._id },
        { razorpayxContactId: contactId, razorpayxFundAccountId: fundAccountId }
      );

      const mode = useUPI ? "UPI" : "IMPS";
      const rzpPayout = await createPayout(
        fundAccountId,
        Number(amount),
        mode,
        String(payout._id)
      );
      payout.gatewayPaymentId = rzpPayout.id;
      if (
        rzpPayout.status === "processed" ||
        rzpPayout.status === "queued" ||
        rzpPayout.status === "pending"
      ) {
        
        const adminWalletService = require("../services/payments/walletService");
        await adminWalletService.adminDebit(Number(amount), "Tutor payout", {
          type: "payout",
          id: payout._id,
        });
        if (rzpPayout.status === "processed") {
          payout.status = "settled";
        }
        await payout.save();
      } else {
        payout.status = "failed";
        await payout.save();
        const Wallet = require("../models/Wallet");
        const w = await Wallet.findOne({ userId });
        if (w) {
          w.balance += Number(amount);
          await w.save();
        }
        await walletService.addTransaction({
          userId,
          type: "credit",
          amount: Number(amount),
          description: "Payout reversal",
          reference: { type: "payout", id: payout._id },
          status: "completed",
          paymentId: payout._id,
        });
        return res.status(500).json({ success: false, message: "Payout failed" });
      }
    } catch (err) {
      const isAuthErr =
        (err && err.response && err.response.status === 401) ||
        (err && err.response && err.response.status === 403);
      if (isAuthErr) {
        payout.status = "created";
        await payout.save();
        return res.json({ success: true, data: { payoutId: payout._id, mode: "offline" } });
      }
      payout.status = "failed";
      await payout.save();
      const Wallet = require("../models/Wallet");
      const w = await Wallet.findOne({ userId });
      if (w) {
        w.balance += Number(amount);
        await w.save();
      }
      await walletService.addTransaction({
        userId,
        type: "credit",
        amount: Number(amount),
        description: "Payout reversal",
        reference: { type: "payout", id: payout._id },
        status: "completed",
        paymentId: payout._id,
      });
      return res.status(500).json({ success: false, message: "Provider error", error: err.message });
    }

    const { createAdminNotification } = require("../services/adminNotification");
    await createAdminNotification(
      "Tutor payout requested",
      `Payout ${payout._id} requested by tutor ${tp.name || tp._id}`,
      { payoutId: payout._id, tutorId: tp._id, amount: Number(amount), upi: tp.upiId || null }
    );

    res.json({ success: true, data: { payoutId: payout._id } });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};
