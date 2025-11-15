const crypto = require("crypto");
const razorpay = require("../services/payments/razorpay"); // <-- create this service
const Payment = require("../models/Payment");
const RegularClass = require("../models/RegularClass");
const TutorProfile = require("../models/TutorProfile");
const { createAdminNotification } = require("../services/adminNotification");

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
    const { regularClassId, billingType, numberOfClasses } = req.body;
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
    const totalAmountINR = rc.amount * Number(numberOfClasses);
    const amountInPaise = Math.round(totalAmountINR * 100);

    // 🧾 Create Razorpay order
    const order = await razorpay.orders.create({
      amount: amountInPaise,
      currency: "INR",
      receipt: `rc_${regularClassId}_${Date.now()}`,
      notes: {
        regularClassId: regularClassId.toString(),
        billingType,
        numberOfClasses: String(numberOfClasses),
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
        notes: `BillingType: ${billingType}, Classes: ${numberOfClasses}`,
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
 * POST /api/payments/razorpay/webhook
 * Razorpay will call this when payment is captured
 * NOTE: use express.raw({ type: "application/json" }) on this route
 */
exports.razorpayWebhook = async (req, res) => {
  try {
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!webhookSecret) {
      console.error("❌ Missing RAZORPAY_WEBHOOK_SECRET env");
      return res.status(500).json({ received: false });
    }

    const rawBody = req.body;         // Buffer
    const bodyString = rawBody.toString("utf8");
    const signature = req.headers["x-razorpay-signature"];

    const expected = crypto
      .createHmac("sha256", webhookSecret)
      .update(bodyString)
      .digest("hex");

    if (expected !== signature) {
      console.warn("❌ Invalid Razorpay webhook signature");
      return res.status(400).json({ received: false });
    }

    const event = JSON.parse(bodyString);

    if (event.event === "payment.captured") {
      const paymentId = event.payload.payment.entity.id;
      const orderId = event.payload.payment.entity.order_id;
      const amount = event.payload.payment.entity.amount / 100;

      let payment = await Payment.findOne({
        $or: [{ gatewayPaymentId: paymentId }, { gatewayOrderId: orderId }],
      });

      if (!payment) {
        console.warn(
          "⚠️ No Payment record found for webhook paymentId/orderId",
          paymentId,
          orderId
        );
        return res.status(200).json({ received: true });
      }

      payment.status = "paid";
      payment.gatewayPaymentId = paymentId;
      payment.amount = amount;
      await payment.save();

      const rc = await RegularClass.findById(payment.regularClassId);
      if (rc) {
        rc.paymentStatus = "paid";
        await rc.save();
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

    res.status(200).json({ received: true });
  } catch (err) {
    console.error("razorpayWebhook error:", err);
    res.status(500).json({ received: false });
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
