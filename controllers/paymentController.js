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

async function recordCouponUse({ coupon, userId, paymentId, amountDiscounted }) {
  if (!coupon) return;
  await CouponUse.create({ couponId: coupon._id, userId, paymentId, amountDiscounted });
  coupon.redemptions = (coupon.redemptions || 0) + 1;
  await coupon.save();
}

async function grantReferralIfEligible({ studentUserId, paymentId, amount }) {
  try {
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
    if (!user || !user.referrerUserId || user.referralRewardGranted) return;
    const rc = user.referralCodeUsed ? await ReferralCode.findOne({ code: user.referralCodeUsed }) : null;
    // Determine referrer role and reward amount from global settings
    const referrer = await User.findById(user.referrerUserId).select("role");
    const settings = await ReferralSettings.findOne();
    const defaultStudent = 100;
    const defaultTutor = 100;
    const rewardAmount = (referrer?.role === "tutor"
      ? (settings?.tutorRewardAmount ?? defaultTutor)
      : (settings?.studentRewardAmount ?? defaultStudent));
    if (rc && rc.maxUses && rc.usedCount >= rc.maxUses) return;
    const refRole = referrer?.role === "student" ? "student" : "tutor";
    const aw1 = await walletService.getAdminWallet();
    if ((aw1?.balance || 0) < rewardAmount) {
      await walletService.adminCredit(rewardAmount, "Referral fund top-up", { type: "referral", id: paymentId });
    }
    await walletService.adminDebit(rewardAmount, "Referral reward", { type: "referral", id: paymentId });
    await walletService.creditWallet(user.referrerUserId, refRole, rewardAmount, "Referral reward", { type: "referral", id: paymentId });
    const bonus = settings?.referredUserBonusAmount ?? 0;
    if (bonus > 0) {
      const aw2 = await walletService.getAdminWallet();
      if ((aw2?.balance || 0) < bonus) {
        await walletService.adminCredit(bonus, "Referral fund top-up", { type: "referral", id: paymentId });
      }
      await walletService.adminDebit(bonus, "Referral signup bonus", { type: "referral", id: paymentId });
      await walletService.creditWallet(user._id, "student", bonus, "Referral signup bonus", { type: "referral", id: paymentId });
    }
    if (rc) {
      await ReferralUse.create({ referralCodeId: rc._id, referrerUserId: user.referrerUserId, referredUserId: user._id, paymentId, rewardGranted: true, amountGranted: rewardAmount });
    }
    user.referralRewardGranted = true;
    await user.save();
    if (rc) {
      rc.usedCount = (rc.usedCount || 0) + 1;
      await rc.save();
    }
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

    if (!regularClassId || !billingType || !numberOfClasses) {
      return res.status(400).json({
        success: false,
        message: "regularClassId, billingType, numberOfClasses are required",
      });
    }

    const rc = await RegularClass.findById(regularClassId);
    if (!rc) {
      return res
        .status(404)
        .json({ success: false, message: "Regular class not found" });
    }

    // 🔐 Optional: ensure the logged-in student matches this regular class
    // You can map User -> StudentProfile here if needed

    // 💰 Compute total amount: per-class rate * numberOfClasses
    // rc.amount is assumed "per class" or "base" price in INR
    let totalAmountINR = rc.amount * Number(numberOfClasses);
    const { discount, coupon } = await applyCouponIfValid({ code: (couponCode || "").trim(), type: "subscription", amount: totalAmountINR, userId });
    if (discount > 0) totalAmountINR = Math.max(0, totalAmountINR - discount);
    const amountInPaise = Math.round(totalAmountINR * 100);

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
            type: "subscription",
            amount: totalAmountINR,
            currency: "INR",
            gateway: "wallet",
            status: "paid",
            periodStart: rc.currentPeriodStart,
            periodEnd: rc.currentPeriodEnd,
            notes: `BillingType: ${billingType}, Classes: ${numberOfClasses}, Coupon:${couponCode || ""}, Discount:${discount || 0}`,
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
        const releaseAt = new Date(baseDate.getTime() + 30 * 24 * 60 * 60 * 1000);
        paymentDoc.releaseAt = releaseAt;
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

    // 🧾 Create Razorpay order
    const order = await razorpay.orders.create({
      amount: amountInPaise,
      currency: "INR",
      receipt: `rc_${regularClassId}_${Date.now()}`,
      notes: {
        regularClassId: regularClassId.toString(),
        billingType,
        numberOfClasses: String(numberOfClasses),
        coupon: couponCode || "",
        discount: String(discount || 0),
      },
    });

    // 💾 Upsert Payment record for this regular class
    // type stays "subscription" because it's a recurring-tuition payment
    const paymentDoc = await Payment.findOneAndUpdate(
      { regularClassId },
      {
        regularClassId,
        // You may want to store StudentProfile/TutorProfile ids instead of user ids
        type: "subscription",
        amount: totalAmountINR,
        currency: "INR",
        gateway: "razorpay",
        gatewayOrderId: order.id,
        status: "created",
        periodStart: rc.currentPeriodStart,
        periodEnd: rc.currentPeriodEnd,
        notes: `BillingType: ${billingType}, Classes: ${numberOfClasses}, Coupon:${couponCode || ""}, Discount:${discount || 0}`,
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
    const hold = (gb.holds || []).find(
      (h) => String(h.studentId) === String(sp._id) && h.status === "active" && new Date(h.expiresAt).getTime() > now
    );
    if (!hold) return res.status(409).json({ success: false, message: "Seat reservation expired or missing" });

    let amountINR = Number(gb.pricePerStudent || 0);
    const { discount } = await applyCouponIfValid({ code: (couponCode || "").trim(), type: "group", amount: amountINR, userId });
    if (discount > 0) amountINR = Math.max(0, amountINR - discount);
    const amountInPaise = Math.round(amountINR * 100);
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
          notes: `Group batch checkout for ${batchId}, Coupon:${couponCode || ""}, Discount:${discount || 0}`,
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

        return res.json({ success: true, walletPaid: true, paymentId: paymentDoc._id });
      }
    } catch (_) {}

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
      notes: `Group batch checkout for ${batchId}, Coupon:${couponCode || ""}, Discount:${discount || 0}`,
    });

    // Link orderId to the student's active seat hold for traceability
    try {
      const now2 = Date.now();
      const idx = (gb.holds || []).findIndex(
        (h) => String(h.studentId) === String(sp._id) && h.status === "active" && new Date(h.expiresAt).getTime() > now2
      );
      if (idx !== -1) {
        gb.holds[idx].orderId = order.id;
        await gb.save();
      }
    } catch (_) {}

    await createAdminNotification(
      "Group batch payment initiated",
      `Order ${order.id} created for batch ${batchId}`,
      { batchId, paymentId: paymentDoc._id, amount: gb.pricePerStudent }
    );
    const metrics = require("../services/metricsService");
    metrics.emit("group.checkout.initiated", { batchId }, { amount: gb.pricePerStudent });

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
            const releaseAt = new Date(baseDate.getTime() + 30 * 24 * 60 * 60 * 1000);
            payment.releaseAt = releaseAt;
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
            const releaseAt = new Date(baseDate.getTime() + 30 * 24 * 60 * 60 * 1000);
            payment.releaseAt = releaseAt;
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
    const p = await Payment.findOne({ type: "payout", gatewayPaymentId: payoutId });
    if (!p) return res.status(200).json({ received: true });

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
            const releaseAt = new Date(baseDate.getTime() + 30 * 24 * 60 * 60 * 1000);
            payment.releaseAt = releaseAt;
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

          await walletService.adminCredit(amount, "Note purchase verified", { type: "note", id: nId });
          await walletService.adminIncreaseHold(tutorNetAmount);

          const TutorProfile = require("../models/TutorProfile");
          const StudentProfile = require("../models/StudentProfile");
          const tutorProfile = await TutorProfile.findById(payment.tutorId).select("userId name");
          const studentProfile = await StudentProfile.findById(payment.studentId).select("userId name");
          const tutorUserId = tutorProfile?.userId || payment.tutorId;
          const studentUserId = studentProfile?.userId || payment.studentId;

          await walletService.creditPending(
            tutorUserId,
            "tutor",
            tutorNetAmount,
            `Payment received for note (locked) — Student: ${studentProfile?.name || "Student"}`,
            { type: "note", id: nId }
          );

          await walletService.addTransaction({
            userId: studentUserId,
            type: "debit",
            amount,
            description: `Payment for note — Tutor: ${tutorProfile?.name || "Tutor"}`,
            reference: { type: "note", id: nId },
            status: "completed",
            paymentId: payment._id,
          });

          const baseDate = new Date();
          const releaseAt = new Date(baseDate.getTime() + 30 * 24 * 60 * 60 * 1000);
          payment.releaseAt = releaseAt;
          payment.walletProcessed = true;
          await payment.save();

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
    if (holdIdx === -1) return res.status(409).json({ success: false, message: "Seat hold missing or expired" });

    gb.holds[holdIdx].status = "finalized";
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
        const releaseAt = new Date(baseDate.getTime() + 30 * 24 * 60 * 60 * 1000);
        payment.releaseAt = releaseAt;
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
        const studentUserIdX = sp2?.userId;
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
      noteTitle: p.noteId?.title || "",
    }));

    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

// Admin: combined payment history (subscription + note + group + payout) with pagination & filters
exports.listAllPaymentsHistory = async (req, res) => {
  try {
    const { from, to, status, type, page = 1, limit = 50, student, tutor } = req.query;
    const pageNum = Math.max(1, Number(page));
    const limitNum = Math.max(1, Number(limit));

    const baseRange = (q = {}) => {
      if (from || to) {
        q.createdAt = {};
        if (from) q.createdAt.$gte = new Date(from);
        if (to) q.createdAt.$lte = new Date(to);
      }
      if (status) q.status = status;
      return q;
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
      ? await Transaction.find(baseRange({ 'reference.type': 'referral' }))
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

    const toRow = (p, extra = {}) => ({
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
      couponCode: (cuMap[String(p._id)]?.couponId?.code) || parseNotes(p.notes).couponCode || "",
      couponDiscount: (cuMap[String(p._id)]?.amountDiscounted) ?? parseNotes(p.notes).couponDiscount ?? 0,
      referralCode: ruMap[String(p._id)]?.referralCodeId?.code || "",
      referralAmount: ruMap[String(p._id)]?.amountGranted || 0,
      referralRewardGranted: Boolean(ruMap[String(p._id)]?.rewardGranted),
      ...extra,
    });

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
    const { paymentId, amount, reason } = req.body;
    const userId = req.user.id;
    if (!paymentId || !amount) {
      return res.status(400).json({ success: false, message: "paymentId and amount are required" });
    }
    const payment = await Payment.findById(paymentId);
    if (!payment) {
      return res.status(404).json({ success: false, message: "Payment not found" });
    }
    if (!['subscription', 'note', 'group'].includes(payment.type) || payment.status !== 'paid') {
      return res.status(400).json({ success: false, message: "Refunds allowed for paid subscription/note/group payments" });
    }
    const RefundRequest = require("../models/RefundRequest");
    const rr = await RefundRequest.create({ paymentId, userId, amount: Number(amount), reason: reason || "" });
    return res.status(201).json({ success: true, data: rr });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

exports.listRefundRequests = async (req, res) => {
  try {
    const { status, from, to } = req.query;
    const RefundRequest = require("../models/RefundRequest");
    const filter = {};
    if (status) filter.status = status;
    if (from || to) {
      filter.createdAt = {};
      if (from) filter.createdAt.$gte = new Date(from);
      if (to) filter.createdAt.$lte = new Date(to);
    }
    const items = await RefundRequest.find(filter).sort({ createdAt: -1 }).lean();
    return res.json({ success: true, data: items });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

exports.updateRefundRequestStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const RefundRequest = require("../models/RefundRequest");
    const rr = await RefundRequest.findById(id);
    if (!rr) return res.status(404).json({ success: false, message: "Refund request not found" });
    if (!['approved', 'rejected', 'processed'].includes(status)) {
      return res.status(400).json({ success: false, message: "Invalid status" });
    }
    if (status === 'approved') {
      rr.status = 'approved';
      await rr.save();
      return res.json({ success: true, data: rr });
    }
    if (status === 'rejected') {
      rr.status = 'rejected';
      await rr.save();
      return res.json({ success: true, data: rr });
    }
    if (status === 'processed') {
      if (rr.status !== 'approved') {
        return res.status(400).json({ success: false, message: "Only approved requests can be processed" });
      }
      const amount = Number(rr.amount || 0);
      const adminWalletService = require("../services/payments/walletService");
      await adminWalletService.adminDebit(amount, "Refund processed", { type: "refund", id: rr._id });
      const userId = rr.userId;
      const Wallet = require("../models/Wallet");
      const User = require("../models/User");
      const user = await User.findById(userId);
      if (user) {
        const wallet = await adminWalletService.ensureWallet(userId, user.role);
        wallet.balance += amount;
        await wallet.save();
        await adminWalletService.addTransaction({ userId, type: "credit", amount, description: "Refund credit", reference: { type: "refund", id: rr._id }, status: "completed" });
      }
      rr.status = 'processed';
      await rr.save();
      return res.json({ success: true, data: rr });
    }
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
    // Referral totals from wallet transactions (credits for referral rewards/bonuses)
    const Transaction = require("../models/Transaction");
    const refs = await Transaction.aggregate([
      { $match: { status: { $in: ["completed", "locked"] }, createdAt: { $gte: start, $lte: end }, 'reference.type': 'referral' } },
      { $group: { _id: bucketFmt, total: { $sum: "$amount" }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]);
    const seriesDates = new Set([...
      subs.map((x) => x._id), ...notes.map((x) => x._id), ...refs.map((x) => x._id)
    ]);
    const commissionPercent = 25;
    const merged = Array.from(seriesDates).sort().map((d) => {
      const s = subs.find((x) => x._id === d);
      const n = notes.find((x) => x._id === d);
      const subTotal = s?.total || 0;
      const noteTotal = n?.total || 0;
      const refTotal = (refs.find((x) => x._id === d)?.total) || 0;
      const commissionTotal = Math.round((subTotal * commissionPercent) / 100);
      return {
        date: d,
        subscriptionTotal: subTotal,
        subscriptionCount: s?.count || 0,
        noteTotal,
        noteCount: n?.count || 0,
        referralTotal: refTotal,
        referralCount: (refs.find((x) => x._id === d)?.count) || 0,
        commissionTotal,
      };
    });
    const totals = {
      subscriptionTotal: merged.reduce((sum, x) => sum + x.subscriptionTotal, 0),
      noteTotal: merged.reduce((sum, x) => sum + x.noteTotal, 0),
      referralTotal: merged.reduce((sum, x) => sum + (x.referralTotal || 0), 0),
      commissionTotal: merged.reduce((sum, x) => sum + x.commissionTotal, 0),
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
    const tp = await TutorProfile.findOne({ userId }).lean();
    if (!tp) return res.status(404).json({ success: false, message: "Tutor profile not found" });
    if (tp.kycStatus !== "approved") {
      return res.status(403).json({ success: false, message: "KYC not approved" });
    }
    const hasUPI = tp.upiId && tp.upiId.trim().length > 0;
    const hasBank = tp.bankAccountNumber && tp.ifsc && tp.accountHolderName;
    if (!hasUPI && !hasBank) {
      return res.status(400).json({ success: false, message: "No payout method (UPI/Bank) set" });
    }

    const Payment = require("../models/Payment");
    const walletService = require("../services/payments/walletService");
    const { ensureContactAndFundAccount, createPayout } = require("../services/payments/payoutProvider");

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

    await walletService.debitWalletGeneric(
      userId,
      "tutor",
      Number(amount),
      "Payout requested",
      { type: "payout", id: payout._id }
    );

    const TutorProfileModel = require("../models/TutorProfile");
    const { contactId, fundAccountId, useUPI } = await ensureContactAndFundAccount(tp);
    await TutorProfileModel.updateOne({ _id: tp._id }, { razorpayxContactId: contactId, razorpayxFundAccountId: fundAccountId });

    const mode = useUPI ? "UPI" : "IMPS";
    try {
      const rzpPayout = await createPayout(fundAccountId, Number(amount), mode, String(payout._id));
      payout.gatewayPaymentId = rzpPayout.id;
      if (rzpPayout.status === "processed" || rzpPayout.status === "queued" || rzpPayout.status === "pending") {
        const adminWalletService = require("../services/payments/walletService");
        await adminWalletService.adminDebit(Number(amount), "Tutor payout", { type: "payout", id: payout._id });
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
        await walletService.addTransaction({ userId, type: "credit", amount: Number(amount), description: "Payout reversal", reference: { type: "payout", id: payout._id }, status: "completed", paymentId: payout._id });
        return res.status(500).json({ success: false, message: "Payout failed" });
      }
    } catch (err) {
      payout.status = "failed";
      await payout.save();
      const Wallet = require("../models/Wallet");
      const w = await Wallet.findOne({ userId });
      if (w) {
        w.balance += Number(amount);
        await w.save();
      }
      await walletService.addTransaction({ userId, type: "credit", amount: Number(amount), description: "Payout reversal", reference: { type: "payout", id: payout._id }, status: "completed", paymentId: payout._id });
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
