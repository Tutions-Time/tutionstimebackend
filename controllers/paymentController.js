const crypto = require("crypto");
const razorpay = require("../services/payments/razorpay"); 
const Payment = require("../models/Payment");
const RegularClass = require("../models/RegularClass");
const TutorProfile = require("../models/TutorProfile");
const StudentProfileModel = require("../models/StudentProfile");
const Note = require("../models/Note");
const { createAdminNotification } = require("../services/adminNotification");
const walletService = require("../services/payments/walletService");
const { default: mongoose } = require("mongoose");
const GroupBatch = require("../models/GroupBatch");
const Coupon = require("../models/Coupon");
const CouponUse = require("../models/CouponUse");
const Session = require("../models/Session");
const RefundRequest = require("../models/RefundRequest");
const notificationService = require("../services/notificationService");
const {
  recalculateSubscriptionRelease,
} = require("../services/payments/subscriptionPayoutService");

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

const DEFAULT_COMMISSION_PERCENT = 25;

function applyCommissionFields(payment, amount, percent = DEFAULT_COMMISSION_PERCENT) {
  const value = Number(amount || 0);
  const commissionAmount = (value * percent) / 100;
  const tutorNetAmount = Math.max(0, value - commissionAmount);
  payment.commissionPercent = percent;
  payment.commissionAmount = commissionAmount;
  payment.tutorNetAmount = tutorNetAmount;
  return { commissionAmount, tutorNetAmount };
}

function isRazorpayOrderPaid(order) {
  const status = String(order?.status || "").toLowerCase();
  const amount = Number(order?.amount || 0);
  const amountPaid = Number(order?.amount_paid || 0);
  return status === "paid" || (amount > 0 && amountPaid >= amount);
}

async function resolveRazorpayPaymentMeta(orderId) {
  const order = await razorpay.orders.fetch(orderId);
  const payments = await razorpay.orders.fetchPayments(orderId).catch(() => []);
  const settledPayment =
    payments.find((item) =>
      ["CAPTURED", "AUTHORIZED"].includes(
        String(item?.status || "").toUpperCase(),
      ),
    ) || payments[0] || null;

  return {
    order,
    paymentId: settledPayment?.id || null,
    orderPaid: isRazorpayOrderPaid(order),
  };
}

const REGULAR_SESSION_DURATION_MINUTES = Number(
  process.env.REGULAR_SESSION_DURATION_MINUTES || 60
);

function startOfUtcDay(date) {
  const d = new Date(date);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function addUtcDays(date, days) {
  const base = startOfUtcDay(date);
  base.setUTCDate(base.getUTCDate() + days);
  return base;
}

function formatDateOnly(date) {
  return new Date(date).toISOString().slice(0, 10);
}

function buildDailyDateRange(startDate, count) {
  return Array.from({ length: count }, (_, index) =>
    formatDateOnly(addUtcDays(startDate, index))
  );
}

function buildMonthlyDateRange(startDate) {
  const start = startOfUtcDay(startDate);
  const monthStart = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1)
  );
  const nextMonthStart = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1)
  );
  const dates = [];

  for (
    let cursor = new Date(monthStart);
    cursor < nextMonthStart;
    cursor = addUtcDays(cursor, 1)
  ) {
    dates.push(formatDateOnly(cursor));
  }

  return dates;
}

function buildDateTime(dateStr, timeStr) {
  const [year, month, day] = dateStr.split("-").map(Number);
  const [H, M] = timeStr.split(":").map(Number);
  return new Date(Date.UTC(year, month - 1, day, H, M, 0, 0));
}

function buildRegularSessionTopic(rc, dateTime) {
  const subject = rc?.subject || "Regular Class";
  const dateLabel = dateTime.toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
  const timeLabel = dateTime.toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });
  return `${subject} - ${timeLabel} on ${dateLabel}`;
}

async function schedulePaidRegularClassFromStoredTime(rc) {
  if (!rc || rc.scheduleStatus === "scheduled") return { scheduled: false };
  const time = rc.timeSlots?.[0]?.time;
  if (!time) return { scheduled: false, reason: "missing-time" };

  const scheduleStartDate =
    startOfUtcDay(rc.startDate) > startOfUtcDay(new Date())
      ? startOfUtcDay(rc.startDate)
      : startOfUtcDay(new Date());

  let selectedDates = [];
  if (rc.planType === "hourly") {
    const n = Number(rc.classCount || 0);
    if (!n || n <= 0) return { scheduled: false, reason: "invalid-class-count" };
    selectedDates = buildDailyDateRange(scheduleStartDate, n);
  } else if (rc.planType === "monthly") {
    selectedDates = buildMonthlyDateRange(scheduleStartDate);
  } else {
    return { scheduled: false, reason: "invalid-plan" };
  }

  const zoomService = require("../services/zoomService");
  const sessionsToInsert = [];
  for (const dateStr of selectedDates) {
    const startDateTime = buildDateTime(dateStr, time);
    let meeting = {};
    try {
      meeting = await zoomService.createZoomMeeting({
        topic: buildRegularSessionTopic(rc, startDateTime),
        startTime: startDateTime.toISOString(),
        duration: REGULAR_SESSION_DURATION_MINUTES,
      });
    } catch (err) {
      console.error("Auto schedule Zoom meeting create failed:", err.message);
    }

    sessionsToInsert.push({
      regularClassId: rc._id,
      studentId: rc.studentId,
      tutorId: rc.tutorId,
      startDateTime,
      meetingId: meeting.id ? String(meeting.id) : "",
      meetingPassword: meeting.password || meeting.encrypted_password || "",
      startUrl: meeting.start_url || "",
      joinUrl: meeting.join_url || "",
      meetingLink: meeting.join_url || "",
      status: "scheduled",
    });
  }

  await Session.deleteMany({ regularClassId: rc._id });
  const created = await Session.insertMany(sessionsToInsert);
  rc.scheduleStatus = "scheduled";
  await rc.save();
  return { scheduled: true, count: created.length };
}

async function autoSchedulePaidRegularClass(rc) {
  try {
    const result = await schedulePaidRegularClassFromStoredTime(rc);
    if (result.scheduled) {
      await createAdminNotification(
        "Regular Class Sessions Scheduled",
        `Auto-scheduled ${result.count} sessions for regular class ${rc._id}`,
        { regularClassId: rc._id, sessionCount: result.count, subject: rc.subject }
      );
    }
    return result;
  } catch (err) {
    console.error("autoSchedulePaidRegularClass error:", err.message);
    return { scheduled: false, reason: err.message };
  }
}

async function resolveProfileName(model, id, fallback) {
  if (!id) return fallback;
  const doc = await model.findById(id).select("name").lean();
  return doc?.name || fallback;
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

async function getOutstandingRefundReservations(paymentId, excludeRequestId = null) {
  const filter = {
    paymentId,
    status: { $in: ["requested", "approved"] },
  };
  if (excludeRequestId) filter._id = { $ne: excludeRequestId };

  const rows = await RefundRequest.find(filter)
    .select("status amount amountApproved")
    .lean();

  return rows.reduce((sum, row) => {
    const effectiveAmount =
      row.status === "approved"
        ? Number(row.amountApproved ?? row.amount ?? 0)
        : Number(row.amount ?? 0);
    return sum + Math.max(0, effectiveAmount);
  }, 0);
}

async function isPaymentOwnedByUser(payment, userId) {
  try {
    const sp = await StudentProfileModel.findById(payment.studentId).select("userId").lean();
    const ownerUserId = sp?.userId || payment.studentId;
    return String(ownerUserId) === String(userId);
  } catch (_) {
    return String(payment.studentId) === String(userId);
  }
}

function matchesTutorIdentity(candidateId, tutorUserId, tutorProfileId) {
  if (!candidateId) return false;
  const id = String(candidateId);
  return id === String(tutorUserId) || (tutorProfileId && id === String(tutorProfileId));
}

async function resolveTutorUserAndProfileId(tutorUserId) {
  const tp = await TutorProfile.findOne({ userId: tutorUserId }).select("_id userId").lean();
  return {
    tutorUserId: String(tutorUserId),
    tutorProfileId: tp?._id ? String(tp._id) : null,
  };
}

async function isPaymentOwnedByTutor(payment, tutorUserId) {
  const ids = await resolveTutorUserAndProfileId(tutorUserId);
  if (matchesTutorIdentity(payment.tutorId, ids.tutorUserId, ids.tutorProfileId)) return true;

  if (payment.type === "subscription" && payment.regularClassId) {
    const rc = await RegularClass.findById(payment.regularClassId).select("tutorId").lean();
    return matchesTutorIdentity(rc?.tutorId, ids.tutorUserId, ids.tutorProfileId);
  }
  if (payment.type === "group" && payment.groupBatchId) {
    const gb = await GroupBatch.findById(payment.groupBatchId).select("tutorId").lean();
    return matchesTutorIdentity(gb?.tutorId, ids.tutorUserId, ids.tutorProfileId);
  }
  if (payment.type === "note" && payment.noteId) {
    const note = await Note.findById(payment.noteId).select("tutorId").lean();
    return matchesTutorIdentity(note?.tutorId, ids.tutorUserId, ids.tutorProfileId);
  }
  return false;
}

async function resolveTutorUserIdFromPayment(payment) {
  const candidate = payment?.tutorId || null;
  if (candidate) {
    const direct = await TutorProfile.findById(candidate).select("userId").lean();
    if (direct?.userId) return direct.userId;
    return candidate;
  }

  if (payment.type === "subscription" && payment.regularClassId) {
    const rc = await RegularClass.findById(payment.regularClassId).select("tutorId").lean();
    if (rc?.tutorId) {
      const tp = await TutorProfile.findById(rc.tutorId).select("userId").lean();
      return tp?.userId || rc.tutorId;
    }
  }
  if (payment.type === "group" && payment.groupBatchId) {
    const gb = await GroupBatch.findById(payment.groupBatchId).select("tutorId").lean();
    if (gb?.tutorId) {
      const tp = await TutorProfile.findById(gb.tutorId).select("userId").lean();
      return tp?.userId || gb.tutorId;
    }
  }
  if (payment.type === "note" && payment.noteId) {
    const note = await Note.findById(payment.noteId).select("tutorId").lean();
    if (note?.tutorId) {
      const tp = await TutorProfile.findById(note.tutorId).select("userId").lean();
      return tp?.userId || note.tutorId;
    }
  }
  return null;
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

    const latestPayment = await Payment.findOne({ regularClassId, type: "subscription" }).sort({ createdAt: -1 }).lean();
    if (rc.paymentStatus === "paid" || latestPayment?.status === "paid") {
      return res.json({
        success: true,
        alreadyActive: true,
        message: "Regular class is already active. No payment is required.",
        paymentId: latestPayment?._id || null,
        regularClassId: rc._id,
      });
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
            payoutGenerated: false,
            payoutId: null,
            releaseAt: null,
            fundReleaseStatus: "pending",
            fundReleaseDate: null,
            fundReleasedAt: null,
            walletProcessed: false,
            paidAt: new Date(),
          },
          { upsert: true, new: true }
        );

        // Ensure paid classes are immediately visible in regular class listings.
        rc.paymentStatus = "paid";
        rc.tutorPaymentStatus = rc.tutorPaymentStatus || "locked";
        if (billingType === "hourly" && classes > 0) {
          rc.classCount = classes;
        }
        await rc.save();
        await autoSchedulePaidRegularClass(rc);

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
        } catch (_) {}

        await recalculateSubscriptionRelease(paymentDoc);
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
          userId,
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
        payoutGenerated: false,
        payoutId: null,
        releaseAt: null,
        fundReleaseStatus: "pending",
        fundReleaseDate: null,
        fundReleasedAt: null,
        walletProcessed: false,
        paidAt: null,
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
      orderId: order.id,
      amount: amountInPaise,
      currency: "INR",
      keyId: razorpay.getKeyId(),
      provider: "razorpay",
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
    const billingType = String(req.body?.billingType || req.body?.planType || "").trim().toLowerCase();
    if (billingType === "hourly") {
      return res.status(400).json({
        success: false,
        message: "Hourly billing is only available for one-to-one classes",
      });
    }
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
        if (!(gb.enrolled || []).some((id) => String(id) === String(sp._id))) {
          gb.enrolled.push(sp._id);
        }
        
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
      notes: { batchId: batchId.toString().slice(-8), studentId: sp._id.toString().slice(-8), coupon: couponCode || "", discount: String(discount || 0), userId },
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

    return res.json({
      success: true,
      orderId: order.id,
      amount: amountInPaise,
      currency: "INR",
      keyId: razorpay.getKeyId(),
      provider: "razorpay",
    });
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
        } catch (_) {}

        await createAdminNotification(
          "Note purchase paid via wallet",
          `Note ${note._id} paid from wallet`,
          { noteId: note._id, paymentId: paymentDoc._id, amount: amountINR }
        );

        return res.json({ success: true, walletPaid: true, paymentId: paymentDoc._id });
      }
    } catch (_) {}

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
        userId,
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
      orderId: order.id,
      amount: amountInPaise,
      currency: "INR",
      paymentId: paymentDoc._id,
      keyId: razorpay.getKeyId(),
      provider: "razorpay",
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
      payment.paidAt = new Date();
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
            await recalculateSubscriptionRelease(payment);
            payment.walletProcessed = true;
            await payment.save();
          }
        } catch (walletErr) {
          console.error("Wallet update error:", walletErr.message);
        }

        // Record coupon usage after successful capture
        try {
          const couponCode = notes && notes.coupon;
          const discountVal = Number(notes && notes.discount ? notes.discount : 0) || 0;
          if (couponCode) {
            const coupon = await Coupon.findOne({ code: couponCode });
            await recordCouponUse({ coupon, userId: studentUserId, paymentId: payment._id, amountDiscounted: discountVal });
          }
        } catch (_) {}
      }

      const studentNameForNotif = await resolveProfileName(
        StudentProfileModel,
        (rc && rc.studentId) || payment.studentId,
        "Student"
      );
      const tutorNameForNotif = await resolveProfileName(
        TutorProfile,
        (rc && rc.tutorId) || payment.tutorId,
        "Tutor"
      );
      await createAdminNotification(
        "Subscription payment received",
        `Subscription payment captured for ${studentNameForNotif} (Tutor: ${tutorNameForNotif})`,
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


exports.cashfreeWebhook = async (req, res) => {
  try {
    const signature = req.headers["x-webhook-signature"];
    const timestamp = req.headers["x-webhook-timestamp"];
    const rawBody = Buffer.isBuffer(req.body)
      ? req.body.toString("utf8")
      : JSON.stringify(req.body || {});

    if (!signature || !timestamp) {
      return res.status(400).json({ received: false });
    }

    if (!razorpay.verifyWebhookSignature(signature, rawBody, timestamp)) {
      return res.status(400).json({ received: false });
    }

    const event = JSON.parse(rawBody);
    const eventType = String(event?.type || event?.event || "").toUpperCase();
    const data = event?.data || event?.payload || {};
    const orderId =
      data?.order?.order_id ||
      data?.order_id ||
      data?.payment?.order_id ||
      data?.payment_entity?.order_id ||
      null;
    const providerPaymentId =
      data?.payment?.cf_payment_id ||
      data?.payment?.payment_id ||
      data?.cf_payment_id ||
      null;

    if (!orderId || !eventType.includes("PAYMENT")) {
      return res.status(200).json({ received: true });
    }

    const payment = await Payment.findOne({ gatewayOrderId: orderId });
    if (payment && payment.status !== "paid") {
      payment.status = "paid";
      payment.gatewayPaymentId = providerPaymentId || payment.gatewayPaymentId;
      payment.paidAt = new Date();
      await payment.save();
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("Cashfree payment webhook error", err);
    return res.status(500).json({ received: false });
  }
};

exports.cashfreePayoutWebhook = async (req, res) => {
  try {
    const signature = req.headers["x-webhook-signature"];
    const timestamp = req.headers["x-webhook-timestamp"];
    const rawBody = Buffer.isBuffer(req.body)
      ? req.body.toString("utf8")
      : JSON.stringify(req.body || {});

    if (!signature || !timestamp) {
      return res.status(400).json({ received: false });
    }

    const payoutProvider = require("../services/payments/payoutProvider");
    if (!payoutProvider.verifyWebhookSignature(signature, rawBody, timestamp)) {
      return res.status(400).json({ received: false });
    }

    const event = JSON.parse(rawBody);
    const eventType = String(event?.type || event?.event || "").toUpperCase();
    const data = event?.data || {};
    const transferId =
      data?.transfer?.transfer_id ||
      data?.transfer_id ||
      data?.cf_transfer_id ||
      null;
    const status = String(
      data?.transfer?.transfer_status || data?.transfer_status || "",
    ).toUpperCase();

    if (!transferId) return res.status(200).json({ received: true });

    const payout = await Payment.findOne({
      type: "payout",
      gatewayPaymentId: transferId,
    });
    if (!payout) return res.status(200).json({ received: true });

    if (status === "SUCCESS" || eventType.includes("TRANSFER_SUCCESS")) {
      payout.status = "settled";
      await payout.save();
      return res.status(200).json({ received: true });
    }

    if (
      ["FAILED", "REVERSED", "CANCELLED"].includes(status) ||
      eventType.includes("TRANSFER_FAILED") ||
      eventType.includes("TRANSFER_REVERSED")
    ) {
      payout.status = "failed";
      await payout.save();

      const tp = await TutorProfile.findById(payout.tutorId).select("userId");
      const userId = tp?.userId || null;
      if (userId) {
        const Wallet = require("../models/Wallet");
        const w = await Wallet.findOne({ userId });
        if (w) {
          w.balance += Number(payout.tutorNetAmount || payout.amount || 0);
          await w.save();
        }
        await walletService.addTransaction({
          userId,
          type: "credit",
          amount: Number(payout.tutorNetAmount || payout.amount || 0),
          description: "Payout reversal",
          reference: { type: "payout", id: payout._id },
          status: "completed",
          paymentId: payout._id,
        });
      }
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("Cashfree payout webhook error", err);
    return res.status(500).json({ received: false });
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
    const {
      orderId: rawOrderId,
      paymentId: rawPaymentId,
      signature: rawSignature,
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      regularClassId,
      billingType,
      numberOfClasses,
      noteId,
    } = req.body;
    const orderId = rawOrderId || razorpay_order_id;
    const paymentIdFromBody = rawPaymentId || razorpay_payment_id;
    const signature = rawSignature || razorpay_signature;

    if (!orderId) {
      return res.status(400).json({ success: false, message: "orderId is required" });
    }

    // Find payment by orderId
    const payment = await Payment.findOne({ gatewayOrderId: orderId });
    if (!payment) {
      return res.status(404).json({ success: false, message: "Payment record not found" });
    }

    if (payment.status !== "paid") {
      if (!paymentIdFromBody || !signature) {
        return res.status(400).json({ success: false, message: "Payment verification details are required" });
      }
      if (!razorpay.verifyPaymentSignature(orderId, paymentIdFromBody, signature)) {
        return res.status(400).json({ success: false, message: "Invalid payment signature" });
      }
    }

    const { paymentId: resolvedPaymentId, orderPaid } = await resolveRazorpayPaymentMeta(orderId);
    const paymentId = paymentIdFromBody || resolvedPaymentId;
    if (!orderPaid && payment.status !== "paid") {
      return res.status(400).json({ success: false, message: "Payment not completed" });
    }

    // Mark payment as paid
    payment.status = "paid";
    payment.gatewayPaymentId = paymentId;
    payment.paidAt = new Date();
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
        await autoSchedulePaidRegularClass(rc);
      }

      // Wallet + release schedule
      try {
        if (!payment.walletProcessed) {
          const amount = payment.amount || 0;
          const { commissionAmount, tutorNetAmount } = applyCommissionFields(
            payment,
            amount
          );

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

            await recalculateSubscriptionRelease(payment);
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

      // Coupon recording for subscription (client verify)
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
          const { commissionAmount, tutorNetAmount } = applyCommissionFields(
            payment,
            amount
          );

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
        try {
          const StudentProfile = require("../models/StudentProfile");
          const sp4 = await StudentProfile.findById(payment.studentId).select("userId");
          const studentUserIdY = sp4?.userId || req.user?.id;
          if (studentUserIdY) {
          }
        } catch (_) {}
      } catch (walletErr) {
        console.error("Wallet update error:", walletErr.message);
      }
    }

    const studentNameForNotif = await resolveProfileName(
      StudentProfileModel,
      payment.studentId,
      "Student"
    );
    const tutorNameForNotif = await resolveProfileName(
      TutorProfile,
      payment.tutorId,
      "Tutor"
    );
    await createAdminNotification(
      payment.type === "note" ? "Note purchase verified" : "Subscription payment verified",
      `Payment for ${studentNameForNotif} (Tutor: ${tutorNameForNotif}) verified via client callback`,
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
    const {
      orderId: rawOrderId,
      paymentId: rawPaymentId,
      signature: rawSignature,
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      batchId,
    } = req.body;
    const orderId = rawOrderId || razorpay_order_id;
    const paymentIdFromBody = rawPaymentId || razorpay_payment_id;
    const signature = rawSignature || razorpay_signature;
    const userId = req.user.id;
    const StudentProfile = require("../models/StudentProfile");
    const sp = await StudentProfile.findOne({ userId }).select("_id");
    if (!sp) {
      return res.status(404).json({ success: false, message: "Student profile not found" });
    }
    if (!orderId) {
      return res.status(400).json({ success: false, message: "orderId is required" });
    }

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

    if (!paymentIdFromBody || !signature) {
      return res.status(400).json({ success: false, message: "Payment verification details are required" });
    }
    if (!razorpay.verifyPaymentSignature(orderId, paymentIdFromBody, signature)) {
      return res.status(400).json({ success: false, message: "Invalid payment signature" });
    }

    const { paymentId: resolvedPaymentId, orderPaid } = await resolveRazorpayPaymentMeta(orderId);
    const paymentId = paymentIdFromBody || resolvedPaymentId;
    if (!orderPaid) {
      return res.status(400).json({ success: false, message: "Payment not completed" });
    }

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
      `Payment for ${sp?.name || "Student"} verified and enrollment finalized`,
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
      // Record coupon usage
      try {
        const studentUserIdX = req.user?.id;
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
      return payment.commissionAmount;
    }
    return srcAmount * 0.25;
  }
  return 0;
};

const payableForPayment = (payment) => {
  const amount = Number(payment.amount || 0);
  const commissionPercent = Number(payment.commissionPercent ?? DEFAULT_COMMISSION_PERCENT);
  const commissionAmount =
    typeof payment.commissionAmount === "number"
      ? Number(payment.commissionAmount || 0)
      : (amount * commissionPercent) / 100;
  const refundTotal = Number(payment.refundTotal || 0);
  const refundTutorShare = (refundTotal * commissionPercent) / 100;
  const grossAfterRefund = Math.max(0, amount - refundTotal);
  const tutorNetAmount =
    typeof payment.tutorNetAmount === "number"
      ? Number(payment.tutorNetAmount || 0)
      : Math.max(0, amount - commissionAmount);
  const tutorPayable = Math.max(0, tutorNetAmount - (refundTotal - refundTutorShare));
  return {
    grossAfterRefund,
    commissionPercent,
    commissionAmount: Math.max(0, grossAfterRefund - tutorPayable),
    tutorPayable,
    refundTotal,
  };
};

const maskAccountNumber = (value) => {
  const raw = String(value || "");
  if (!raw) return "";
  if (raw.length <= 4) return raw;
  return `${"*".repeat(Math.max(0, raw.length - 4))}${raw.slice(-4)}`;
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

    const allPayments = [...subs, ...notes, ...groups];
    const allIds = allPayments.map((p) => p._id);
    const CouponUse = require("../models/CouponUse");
    const coupons = allIds.length ? await CouponUse.find({ paymentId: { $in: allIds } }).populate({ path: "couponId", select: "code value type" }).lean() : [];
    const cuMap = coupons.reduce((acc, c) => { acc[String(c.paymentId)] = c; return acc; }, {});

    const parseNotes = (n) => {
      const s = String(n || "");
      const cm = s.match(/Coupon:([^,]*)/);
      const dm = s.match(/Discount:(\d+)/);
      return { couponCode: cm && cm[1] ? cm[1].trim() : "", couponDiscount: dm && dm[1] ? Number(dm[1]) : 0 };
    };

    const toRow = (p, extra = {}) => {
      const adminAmount = computeAdminAmount(p);
      const tutorNet =
        p.tutorNetAmount ?? Math.max(0, Number(p.amount || 0) - adminAmount);
      const releaseStatus = p.fundReleaseStatus || "pending";
      const pendingReleaseAmount = releaseStatus !== "released" ? tutorNet : 0;
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
        studentName: p.studentId?.name || "Students",
        tutorName: p.tutorId?.name || "Tutor",
        adminAmount,
        couponCode: (cuMap[String(p._id)]?.couponId?.code) || parseNotes(p.notes).couponCode || "",
        couponDiscount: (cuMap[String(p._id)]?.amountDiscounted) ?? parseNotes(p.notes).couponDiscount ?? 0,
        tutorNetAmount: tutorNet,
        fundReleaseStatus: releaseStatus,
        fundReleaseDate: p.fundReleaseDate,
        fundReleasedAt: p.fundReleasedAt,
        pendingReleaseAmount,
        refundAmount: Number(p.refundTotal || 0),
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


    const nameMatch = (n, q) => (q ? String(n || "").toLowerCase().includes(String(q).toLowerCase()) : true);
    if (student) {
      mapSub = mapSub.filter((r) => nameMatch(r.studentName, student));
      mapNote = mapNote.filter((r) => nameMatch(r.studentName, student));
      mapGroup = mapGroup.filter((r) => nameMatch(r.studentName, student));
      mapPayout = mapPayout.filter((r) => nameMatch(r.studentName, student));
    }
    if (tutor) {
      mapSub = mapSub.filter((r) => nameMatch(r.tutorName, tutor));
      mapNote = mapNote.filter((r) => nameMatch(r.tutorName, tutor));
      mapGroup = mapGroup.filter((r) => nameMatch(r.tutorName, tutor));
      mapPayout = mapPayout.filter((r) => nameMatch(r.tutorName, tutor));
    }

    const combinedAll = [...mapSub, ...mapNote, ...mapGroup, ...mapPayout].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
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

/**
 * Admin: list tutors with unpaid payable amounts after platform commission.
 * GET /api/payments/admin/tutor-payables?status=pending|paid&from=YYYY-MM-DD&to=YYYY-MM-DD&q=Tutor
 */
exports.listTutorPayables = async (req, res) => {
  try {
    const { status = "pending", from, to, q = "" } = req.query;
    const dateFilter = {};
    if (from || to) {
      dateFilter.createdAt = {};
      if (from) dateFilter.createdAt.$gte = new Date(from);
      if (to) dateFilter.createdAt.$lte = new Date(to);
    }

    if (status === "paid") {
      const payouts = await Payment.find({ type: "payout", status: "settled", ...dateFilter })
        .sort({ manuallyPaidAt: -1, updatedAt: -1 })
        .populate({ path: "tutorId", select: "userId name email upiId accountHolderName bankAccountNumber ifsc" })
        .lean();

      const paidRows = payouts
        .map((p) => ({
          payoutId: p._id,
          tutorId: p.tutorId?._id || p.tutorId,
          tutorUserId: p.tutorId?.userId || null,
          tutorName: p.tutorId?.name || "Tutor",
          tutorEmail: p.tutorId?.email || "",
          sourceCount: Array.isArray(p.payoutSourcePaymentIds) ? p.payoutSourcePaymentIds.length : 0,
          grossAmount: Number(p.amount || 0),
          commissionAmount: Number(p.commissionAmount || 0),
          payableAmount: Number(p.tutorNetAmount || p.amount || 0),
          status: p.status,
          paidAt: p.manuallyPaidAt || p.updatedAt,
          note: p.adminPayoutNote || p.notes || "",
          upiId: p.tutorId?.upiId || "",
          bank: p.tutorId?.bankAccountNumber
            ? {
                accountHolderName: p.tutorId?.accountHolderName || "",
                bankAccountNumber: p.tutorId?.bankAccountNumber || "",
                maskedAccountNumber: maskAccountNumber(p.tutorId?.bankAccountNumber),
                ifsc: p.tutorId?.ifsc || "",
              }
            : null,
        }))
        .filter((row) =>
          q ? String(row.tutorName || "").toLowerCase().includes(String(q).toLowerCase()) : true
        );

      return res.json({
        success: true,
        data: paidRows,
        totals: {
          tutors: paidRows.length,
          grossAmount: paidRows.reduce((sum, r) => sum + Number(r.grossAmount || 0), 0),
          commissionAmount: paidRows.reduce((sum, r) => sum + Number(r.commissionAmount || 0), 0),
          payableAmount: paidRows.reduce((sum, r) => sum + Number(r.payableAmount || 0), 0),
        },
      });
    }

    const sourceFilter = {
      type: { $in: ["subscription", "note", "group"] },
      status: "paid",
      fundReleaseStatus: { $ne: "released" },
      ...dateFilter,
    };
    const sourcePayments = await Payment.find(sourceFilter)
      .sort({ createdAt: -1 })
      .populate({ path: "tutorId", select: "userId name email upiId accountHolderName bankAccountNumber ifsc kycStatus" })
      .lean();

    const rowsByTutor = new Map();
    for (const p of sourcePayments) {
      const tutorProfile = p.tutorId;
      const tutorProfileId = String(tutorProfile?._id || p.tutorId || "");
      if (!tutorProfileId) continue;
      const payable = payableForPayment(p);
      if (payable.tutorPayable <= 0) continue;

      if (!rowsByTutor.has(tutorProfileId)) {
        rowsByTutor.set(tutorProfileId, {
          tutorId: tutorProfile?._id || p.tutorId,
          tutorUserId: tutorProfile?.userId || null,
          tutorName: tutorProfile?.name || "Tutor",
          tutorEmail: tutorProfile?.email || "",
          kycStatus: tutorProfile?.kycStatus || "pending",
          upiId: tutorProfile?.upiId || "",
          bank: tutorProfile?.bankAccountNumber
            ? {
                accountHolderName: tutorProfile?.accountHolderName || "",
                bankAccountNumber: tutorProfile?.bankAccountNumber || "",
                maskedAccountNumber: maskAccountNumber(tutorProfile?.bankAccountNumber),
                ifsc: tutorProfile?.ifsc || "",
              }
            : null,
          sourcePaymentIds: [],
          sourceCount: 0,
          grossAmount: 0,
          refundAmount: 0,
          commissionAmount: 0,
          payableAmount: 0,
          latestPaymentAt: p.createdAt,
          status: "pending",
        });
      }
      const row = rowsByTutor.get(tutorProfileId);
      row.sourcePaymentIds.push(p._id);
      row.sourceCount += 1;
      row.grossAmount += payable.grossAfterRefund;
      row.refundAmount += payable.refundTotal;
      row.commissionAmount += payable.commissionAmount;
      row.payableAmount += payable.tutorPayable;
      if (new Date(p.createdAt) > new Date(row.latestPaymentAt)) row.latestPaymentAt = p.createdAt;
    }

    const withdrawalRequests = await Payment.find({
      type: "payout",
      status: "created",
      ...dateFilter,
    })
      .sort({ createdAt: -1 })
      .populate({ path: "tutorId", select: "userId name email upiId accountHolderName bankAccountNumber ifsc kycStatus" })
      .lean();

    let rows = [
      ...Array.from(rowsByTutor.values()),
      ...withdrawalRequests.map((p) => {
        const tutorProfile = p.tutorId;
        return {
          payoutId: p._id,
          tutorId: tutorProfile?._id || p.tutorId,
          tutorUserId: tutorProfile?.userId || null,
          tutorName: tutorProfile?.name || "Tutor",
          tutorEmail: tutorProfile?.email || "",
          kycStatus: tutorProfile?.kycStatus || "pending",
          upiId: tutorProfile?.upiId || "",
          bank: tutorProfile?.bankAccountNumber
            ? {
                accountHolderName: tutorProfile?.accountHolderName || "",
                bankAccountNumber: tutorProfile?.bankAccountNumber || "",
                maskedAccountNumber: maskAccountNumber(tutorProfile?.bankAccountNumber),
                ifsc: tutorProfile?.ifsc || "",
              }
            : null,
          sourcePaymentIds: [],
          sourceCount: 1,
          requestType: "withdrawal",
          grossAmount: Number(p.amount || 0),
          refundAmount: 0,
          commissionAmount: Number(p.commissionAmount || 0),
          payableAmount: Number(p.tutorNetAmount || p.amount || 0),
          latestPaymentAt: p.createdAt,
          note: p.adminPayoutNote || p.notes || "",
          status: "pending",
        };
      }),
    ].sort((a, b) => Number(b.payableAmount) - Number(a.payableAmount));
    if (q) {
      const needle = String(q).toLowerCase();
      rows = rows.filter((row) =>
        [row.tutorName, row.tutorEmail, row.upiId, row.bank?.accountHolderName]
          .some((value) => String(value || "").toLowerCase().includes(needle))
      );
    }

    return res.json({
      success: true,
      data: rows,
      totals: {
        tutors: rows.length,
        grossAmount: rows.reduce((sum, r) => sum + Number(r.grossAmount || 0), 0),
        refundAmount: rows.reduce((sum, r) => sum + Number(r.refundAmount || 0), 0),
        commissionAmount: rows.reduce((sum, r) => sum + Number(r.commissionAmount || 0), 0),
        payableAmount: rows.reduce((sum, r) => sum + Number(r.payableAmount || 0), 0),
      },
    });
  } catch (err) {
    console.error("listTutorPayables error:", err);
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

/**
 * Admin: mark a tutor's pending payout as paid after manual transfer.
 * POST /api/payments/admin/tutor-payables/:tutorId/mark-paid
 */
exports.markTutorPayablePaid = async (req, res) => {
  try {
    const { tutorId } = req.params;
    const { sourcePaymentIds = [], payoutId = "", note = "" } = req.body || {};
    if (!mongoose.Types.ObjectId.isValid(tutorId)) {
      return res.status(400).json({ success: false, message: "Invalid tutor id" });
    }

    const tutorProfile = await TutorProfile.findById(tutorId).select(
      "userId name email upiId accountHolderName bankAccountNumber ifsc"
    );
    if (!tutorProfile) {
      return res.status(404).json({ success: false, message: "Tutor not found" });
    }

    if (payoutId) {
      if (!mongoose.Types.ObjectId.isValid(payoutId)) {
        return res.status(400).json({ success: false, message: "Invalid payout id" });
      }
      const payout = await Payment.findOne({ _id: payoutId, tutorId: tutorProfile._id, type: "payout", status: "created" });
      if (!payout) {
        return res.status(404).json({ success: false, message: "Withdrawal request not found" });
      }

      const payableAmount = Math.round(Number(payout.tutorNetAmount || payout.amount || 0) * 100) / 100;
      if (payableAmount <= 0) {
        return res.status(400).json({ success: false, message: "Payable amount is zero" });
      }

      payout.status = "settled";
      payout.adminPayoutNote = String(note || "").trim();
      payout.notes = note ? `Tutor payout. Note: ${String(note).trim()}` : "Tutor payout";
      payout.manuallyPaidAt = new Date();
      payout.paidAt = new Date();
      if (mongoose.Types.ObjectId.isValid(req.user?.id)) payout.manuallyPaidBy = req.user.id;
      await payout.save();

      try {
        await walletService.adminDebit(payableAmount, "Tutor payout", {
          type: "payout",
          id: payout._id,
        });
      } catch (walletErr) {
        const adminWallet = await walletService.getAdminWallet();
        adminWallet.balance = Math.max(0, Number(adminWallet.balance || 0) - payableAmount);
        await adminWallet.save();
        console.warn("Withdrawal payout admin wallet debit adjusted:", walletErr.message);
      }

      const Transaction = require("../models/Transaction");
      if (tutorProfile.userId) {
        await Transaction.updateMany(
          {
            userId: tutorProfile.userId,
            "reference.type": "payout",
            "reference.id": payout._id,
          },
          {
            $set: {
              type: "credit",
              description: "Credited to your bank account",
              status: "completed",
              paymentId: payout._id,
            },
          }
        );

        const amountLabel = `₹${payableAmount.toLocaleString("en-IN", {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })}`;
        const body = note
          ? `You got paid ${amountLabel}. Note from admin: ${String(note).trim()}`
          : `You got paid ${amountLabel}.`;
        await notificationService.notifyUser(tutorProfile.userId, "Tutor payout paid", body, {
          payoutId: payout._id,
          amount: payableAmount,
          route: "/wallet",
        });
      }

      await createAdminNotification(
        "Tutor payout marked paid",
        `Paid ₹${payableAmount.toLocaleString("en-IN")} to ${tutorProfile.name || "Tutor"}`,
        { payoutId: payout._id, tutorId: tutorProfile._id, amount: payableAmount }
      );

      return res.json({
        success: true,
        message: "Tutor payout marked as paid",
        data: {
          payoutId: payout._id,
          tutorId: tutorProfile._id,
          tutorName: tutorProfile.name || "Tutor",
          grossAmount: Number(payout.amount || 0),
          refundAmount: 0,
          commissionAmount: Number(payout.commissionAmount || 0),
          payableAmount,
          status: payout.status,
          paidAt: payout.manuallyPaidAt,
          note: payout.adminPayoutNote || "",
        },
      });
    }

    const sourceFilter = {
      tutorId,
      type: { $in: ["subscription", "note", "group"] },
      status: "paid",
      fundReleaseStatus: { $ne: "released" },
    };
    if (Array.isArray(sourcePaymentIds) && sourcePaymentIds.length) {
      sourceFilter._id = { $in: sourcePaymentIds.filter((id) => mongoose.Types.ObjectId.isValid(id)) };
    }

    const sources = await Payment.find(sourceFilter);
    if (!sources.length) {
      return res.status(400).json({ success: false, message: "No pending payable payments found" });
    }

    let grossAmount = 0;
    let refundAmount = 0;
    let commissionAmount = 0;
    let payableAmount = 0;
    for (const source of sources) {
      const payable = payableForPayment(source);
      grossAmount += payable.grossAfterRefund;
      refundAmount += payable.refundTotal;
      commissionAmount += payable.commissionAmount;
      payableAmount += payable.tutorPayable;
    }
    payableAmount = Math.round(payableAmount * 100) / 100;
    if (payableAmount <= 0) {
      return res.status(400).json({ success: false, message: "Payable amount is zero" });
    }

    const payout = await Payment.create({
      tutorId: tutorProfile._id,
      type: "payout",
      amount: Math.round(grossAmount * 100) / 100,
      currency: "INR",
      gateway: "manual",
      commissionPercent: DEFAULT_COMMISSION_PERCENT,
      commissionAmount: Math.round(commissionAmount * 100) / 100,
      tutorNetAmount: payableAmount,
      payoutSourcePaymentIds: sources.map((p) => p._id),
      status: "settled",
      notes: note ? `Manual tutor payout. Note: ${String(note).trim()}` : "Manual tutor payout",
      adminPayoutNote: String(note || "").trim(),
      ...(mongoose.Types.ObjectId.isValid(req.user?.id) && { manuallyPaidBy: req.user.id }),
      manuallyPaidAt: new Date(),
      paidAt: new Date(),
    });

    try {
      await walletService.adminDebit(payableAmount, "Manual tutor payout", {
        type: "payout",
        id: payout._id,
      });
    } catch (walletErr) {
      const adminWallet = await walletService.getAdminWallet();
      adminWallet.balance = Math.max(0, Number(adminWallet.balance || 0) - payableAmount);
      await adminWallet.save();
      console.warn("Manual payout admin wallet debit adjusted:", walletErr.message);
    }
    await walletService.adminDecreaseHold(payableAmount);

    if (tutorProfile.userId) {
      await walletService.clearPendingForManualPayout(
        tutorProfile.userId,
        "tutor",
        payableAmount,
        "Payout received",
        { type: "payout", id: payout._id },
        payout._id
      );

      await Payment.updateMany(
        { _id: { $in: sources.map((p) => p._id) } },
        {
          $set: {
            payoutGenerated: true,
            payoutId: payout._id,
            fundReleaseStatus: "released",
            fundReleasedAt: payout.manuallyPaidAt,
          },
        }
      );

      const amountLabel = `₹${payableAmount.toLocaleString("en-IN", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}`;
      const body = note
        ? `You got paid ${amountLabel}. Note from admin: ${String(note).trim()}`
        : `You got paid ${amountLabel}.`;
      await notificationService.notifyUser(tutorProfile.userId, "Tutor payout paid", body, {
        payoutId: payout._id,
        amount: payableAmount,
        sourcePaymentIds: sources.map((p) => p._id),
        route: "/wallet",
      });
    }

    await createAdminNotification(
      "Tutor payout marked paid",
      `Paid ₹${payableAmount.toLocaleString("en-IN")} to ${tutorProfile.name || "Tutor"}`,
      { payoutId: payout._id, tutorId: tutorProfile._id, amount: payableAmount }
    );

    return res.json({
      success: true,
      message: "Tutor payout marked as paid",
      data: {
        payoutId: payout._id,
        tutorId: tutorProfile._id,
        tutorName: tutorProfile.name || "Tutor",
        grossAmount,
        refundAmount,
        commissionAmount,
        payableAmount,
        status: payout.status,
        paidAt: payout.manuallyPaidAt,
        note: payout.adminPayoutNote || "",
      },
    });
  } catch (err) {
    console.error("markTutorPayablePaid error:", err);
    return res.status(500).json({ success: false, message: err.message || "Server error" });
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
    if (!(await isPaymentOwnedByUser(payment, userId))) {
      return res.status(403).json({ success: false, message: "Not authorized for this payment" });
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
    if (!(reasonText && String(reasonText).trim().length >= 5)) {
      return res.status(400).json({ success: false, message: "Description is required (minimum 5 characters)" });
    }
    const studentProfile = await StudentProfileModel.findOne({ userId })
      .select("upiId accountHolderName bankAccountNumber ifsc")
      .lean();
    const normalizedUpiId = String(studentProfile?.upiId || "").trim();
    const accountHolderName = String(studentProfile?.accountHolderName || "").trim();
    const bankAccountNumber = String(studentProfile?.bankAccountNumber || "").trim();
    const ifsc = String(studentProfile?.ifsc || "").trim().toUpperCase();
    const hasPayoutDetails =
      normalizedUpiId &&
      normalizedUpiId.includes("@") &&
      !/\s/.test(normalizedUpiId) &&
      accountHolderName &&
      bankAccountNumber &&
      ifsc;
    if (!hasPayoutDetails) {
      return res.status(400).json({
        success: false,
        message: "Complete payout details (UPI + bank) in profile before requesting a refund",
        requiresPayoutDetails: true,
        actionPath: "/dashboard/student/profile",
      });
    }
    let ctx = await getRefundContext(paymentId);
    ctx = applyReasonModifier(ctx, reasonCode);
    const reservedAmount = await getOutstandingRefundReservations(paymentId);
    const suggestedAmount = Math.max(0, Number(ctx.remainingRefundable || 0) - reservedAmount);
    if (suggestedAmount <= 0) {
      return res.status(400).json({ success: false, message: "No refundable amount remaining" });
    }
    const rr = await RefundRequest.create({
      paymentId,
      userId,
      amount: Number(suggestedAmount),
      reason: reasonText || "",
      reasonCode,
      reasonText: reasonText || null,
      upiId: normalizedUpiId,
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

    try {
      const { createAdminNotification } = require("../services/adminNotification");
      void createAdminNotification(
        "Refund Requested",
        `Student ${studentName || userId} requested a refund for ${courseLabel || payment.type} (Amount: ${suggestedAmount})`,
        {
          refundRequestId: rr._id,
          paymentId,
          studentId: userId,
          amount: suggestedAmount,
          reasonCode,
          upiId: normalizedUpiId,
          courseLabel
        }
      );
    } catch (err) {
      console.error("Failed to create admin notification for refund request:", err);
    }

    try {
      const notificationService = require("../services/notificationService");
      const tutorUserId = await resolveTutorUserIdFromPayment(payment);
      if (tutorUserId) {
        await notificationService.notifyUser(
          tutorUserId,
          "Refund Request From Student",
          `Student ${studentName || userId} raised a refund request for ${courseLabel || payment.type}`,
          {
            refundRequestId: rr._id,
            paymentId,
            reasonCode,
            reasonText: String(reasonText || "").trim(),
          }
        );
      }
    } catch (_) {}

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
      .populate({ path: "adminUserId", select: "name email role" })
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
    const { status, amountApproved } = req.body;
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
      const reservedByOthers = await getOutstandingRefundReservations(rr.paymentId, rr._id);
      const maxRemaining = Math.max(0, Number(ctx.remainingRefundable || 0) - reservedByOthers);
      let approved = Number(amountApproved || rr.amount || 0);
      approved = Math.min(approved, maxRemaining);
      if (approved <= 0) {
        return res.status(400).json({ success: false, message: "No refundable amount remaining" });
      }
      rr.status = 'approved';
      rr.amountApproved = approved;
      rr.method = "manual";
      rr.providerStatus = "manual_paid";
      rr.processedAt = new Date();
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
        await notificationService.notifyUser(rr.userId, "Refund Approved", "Your refund was approved and will be settled manually by admin", { refundRequestId: rr._id, amountApproved: rr.amountApproved, method: rr.method });
      } catch (_) {}
      payment.refundTotal = Math.max(0, Number(payment.refundTotal || 0) + Number(rr.amountApproved || 0));
      if (!Array.isArray(payment.refunds)) payment.refunds = [];
      if (!payment.refunds.find((x) => String(x) === String(rr._id))) payment.refunds.push(rr._id);
      await payment.save();

      try {
        const TutorProfile = require("../models/TutorProfile");
        const StudentProfile = require("../models/StudentProfile");
        const tp = await TutorProfile.findById(payment.tutorId).select("userId");
        const sp = await StudentProfile.findById(payment.studentId).select("userId");
        const tutorUserId = tp?.userId || payment.tutorId;
        const studentUserId = sp?.userId || payment.studentId;
        const commissionPercent = Number(payment.commissionPercent || 25);
        const commissionAmount = (Number(rr.amountApproved || 0) * commissionPercent) / 100;
        const tutorNetAmount = Math.max(0, Number(rr.amountApproved || 0) - commissionAmount);
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
          await notificationService.notifyUser(studentUserId, "Refund Processed", "Your manual refund has been processed", { refundRequestId: rr._id, amount: Number(rr.amountApproved || 0) });
          await notificationService.notifyUser(tutorUserId, "Refund Adjustment", "A refund adjustment affected your earnings", { refundRequestId: rr._id, amount: tutorNetAmount });
        } catch (_) {}
      } catch (_) {}

      try {
        await createAdminNotification(
          "Refund marked approved (manual)",
          `Refund ${rr._id} approved after manual settlement`,
          { refundRequestId: rr._id, paymentId: payment._id, amount: rr.amountApproved }
        );
      } catch (_) {}
      return res.json({ success: true, data: rr, warning: "Manual mode: no Razorpay/RazorpayX call was made" });
    }
    if (status === 'rejected') {
      rr.status = 'rejected';
      await rr.save();
      try {
        const notificationService = require("../services/notificationService");
        await notificationService.notifyUser(
          rr.userId,
          "Refund Rejected",
          "Your refund request was rejected",
          { refundRequestId: rr._id }
        );
      } catch (_) {}
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

exports.listTutorRefundRequests = async (req, res) => {
  try {
    const tutorUserId = req.user.id;
    const { status } = req.query;

    const filter = {};
    if (status) filter.status = status;

    const items = await RefundRequest.find(filter)
      .sort({ createdAt: -1 })
      .populate({
        path: "paymentId",
        select: "type amount currency gateway tutorId studentId regularClassId groupBatchId noteId",
        populate: [
          { path: "tutorId", select: "name" },
          { path: "studentId", select: "name" },
          {
            path: "regularClassId",
            select: "subject tutorId studentId",
            populate: [{ path: "tutorId", select: "name" }, { path: "studentId", select: "name" }],
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
      .populate({ path: "userId", select: "name" })
      .lean();

    const visible = [];
    for (const r of items) {
      const payment = r.paymentId;
      if (!payment) continue;
      const belongs = await isPaymentOwnedByTutor(payment, tutorUserId);
      if (!belongs) continue;

      const type = payment.type || null;
      let courseLabel = null;
      if (type === "subscription" && payment.regularClassId) {
        courseLabel = payment.regularClassId?.subject || null;
      } else if (type === "group" && payment.groupBatchId) {
        courseLabel = payment.groupBatchId?.subject || null;
      } else if (type === "note" && payment.noteId) {
        courseLabel = payment.noteId?.title || payment.noteId?.subject || null;
      }

      const studentName =
        payment.studentId?.name ||
        payment.regularClassId?.studentId?.name ||
        r.userId?.name ||
        null;

      visible.push({
        ...r,
        paymentType: type,
        paymentAmount: payment.amount || 0,
        paymentGateway: payment.gateway || null,
        courseLabel,
        studentName,
      });
    }

    return res.json({ success: true, data: visible });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

exports.submitTutorRefundReview = async (req, res) => {
  try {
    const tutorUserId = req.user.id;
    const { id } = req.params;
    const decision = String(req.body?.decision || "").trim().toLowerCase();
    const tutorDescription = String(req.body?.tutorDescription || "").trim();

    if (!["legal", "illegal"].includes(decision)) {
      return res.status(400).json({ success: false, message: "decision must be legal or illegal" });
    }
    if (tutorDescription.length < 5) {
      return res.status(400).json({ success: false, message: "Tutor description is required (minimum 5 characters)" });
    }

    const rr = await RefundRequest.findById(id);
    if (!rr) return res.status(404).json({ success: false, message: "Refund request not found" });

    const payment = await Payment.findById(rr.paymentId);
    if (!payment) return res.status(404).json({ success: false, message: "Payment not found" });

    const belongs = await isPaymentOwnedByTutor(payment, tutorUserId);
    if (!belongs) return res.status(403).json({ success: false, message: "Not authorized" });

    rr.tutorDecision = decision;
    rr.tutorDescription = tutorDescription;
    rr.tutorReviewedBy = tutorUserId;
    rr.tutorReviewedAt = new Date();
    await rr.save();

    try {
      await createAdminNotification(
        "Tutor reviewed refund request",
        `Tutor marked refund request ${rr._id} as ${decision}`,
        { refundRequestId: rr._id, decision, tutorDescription }
      );
    } catch (_) {}

    return res.json({ success: true, data: rr });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

exports.previewRefund = async (req, res) => {
  try {
    const { paymentId, reasonCode, reasonText } = req.body;
    const userId = req.user.id;
    if (!paymentId) {
      return res.status(400).json({ success: false, message: "paymentId is required" });
    }
    const payment = await Payment.findById(paymentId);
    if (!payment) {
      return res.status(404).json({ success: false, message: "Payment not found" });
    }
    if (!(await isPaymentOwnedByUser(payment, userId))) {
      return res.status(403).json({ success: false, message: "Not authorized for this payment" });
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
    const reservedAmount = await getOutstandingRefundReservations(paymentId);
    const maximumRefundableAmount = Math.max(0, Number(ctx.remainingRefundable || 0) - reservedAmount);
    const suggestedRefundMethod = payment.gateway === "razorpay" ? "provider" : "payout";
    const explanation = `Completion ${(Math.round(ctx.completionPercentage * 100))}% → refundable ${(Math.round(ctx.refundablePercentage * 100))}%`;
    return res.json({
      success: true,
      data: {
        completionPercentage: ctx.completionPercentage,
        refundablePercentage: ctx.refundablePercentage,
        maximumRefundableAmount,
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
    const seriesDates = new Set([...
      subs.map((x) => x._id),
      ...notes.map((x) => x._id),
      ...groups.map((x) => x._id),
    ]);
    const commissionPercent = 25;
    const merged = Array.from(seriesDates).sort().map((d) => {
      const s = subs.find((x) => x._id === d);
      const n = notes.find((x) => x._id === d);
      const g = groups.find((x) => x._id === d);
      const subTotal = s?.total || 0;
      const noteTotal = n?.total || 0;
      const groupTotal = g?.total || 0;
      const commissionTotal = Math.round(((subTotal + noteTotal + groupTotal) * commissionPercent) / 100);
      return {
        date: d,
        subscriptionTotal: subTotal,
        subscriptionCount: s?.count || 0,
        noteTotal,
        noteCount: n?.count || 0,
        groupTotal,
        groupCount: g?.count || 0,
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

    await createAdminNotification(
      "Tutor withdrawal requested",
      `Tutor ${tp.name || tp._id} requested a withdrawal of ₹${Number(amount).toLocaleString("en-IN")}`,
      { payoutId: payout._id, tutorId: tp._id, amount: Number(amount), upi: tp.upiId || null }
    );

    return res.json({
      success: true,
      message: "Your withdrawal request has been submitted. Money will be transferred to your bank account soon.",
      data: { payoutId: payout._id, mode: "manual" },
    });

    const TutorProfileModel = require("../models/TutorProfile");
    const hasKeys =
      (process.env.CASHFREE_PAYOUT_CLIENT_ID ||
        process.env.CASHFREE_CLIENT_ID ||
        process.env.CASHFREE_APP_ID) &&
      (process.env.CASHFREE_PAYOUT_CLIENT_SECRET ||
        process.env.CASHFREE_CLIENT_SECRET ||
        process.env.CASHFREE_SECRET_KEY);
    try {
      if (!hasKeys) {
        payout.status = "created";
        await payout.save();
        return res.json({ success: true, data: { payoutId: payout._id, mode: "offline" } });
      }
      const { contactId, fundAccountId, useUPI } = await ensureContactAndFundAccount(tp);
      await TutorProfileModel.updateOne(
        { _id: tp._id },
        {
          cashfreeBeneficiaryId: fundAccountId,
          razorpayxContactId: contactId,
          razorpayxFundAccountId: fundAccountId,
        }
      );

      const mode = useUPI ? "UPI" : "IMPS";
      const rzpPayout = await createPayout(
        fundAccountId,
        Number(amount),
        mode,
        String(payout._id)
      );
      payout.gatewayPaymentId =
        rzpPayout.transfer_id || rzpPayout.id || payout.gatewayPaymentId;
      if (
        ["SUCCESS", "QUEUED", "PENDING"].includes(
          String(rzpPayout.transfer_status || rzpPayout.status || "").toUpperCase()
        )
      ) {
        
        const adminWalletService = require("../services/payments/walletService");
        await adminWalletService.adminDebit(Number(amount), "Tutor payout", {
          type: "payout",
          id: payout._id,
        });
        if (
          String(rzpPayout.transfer_status || rzpPayout.status || "").toUpperCase() ===
          "SUCCESS"
        ) {
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



