const Payment = require("../models/Payment");
const RegularClass = require("../models/RegularClass");
const TutorProfile = require("../models/TutorProfile");
const { createAdminNotification } = require("../services/adminNotification");

/**
 * POST /api/payments/razorpay/webhook
 * Razorpay will call this when payment is captured
 */
exports.razorpayWebhook = async (req, res) => {
  try {
    const event = req.body;

    // TODO: verify signature using Razorpay secret

    if (event.event === "payment.captured") {
      const paymentId = event.payload.payment.entity.id;
      const orderId = event.payload.payment.entity.order_id;
      const amount = event.payload.payment.entity.amount / 100; // rupees

      const payment = await Payment.findOne({
        gatewayPaymentId: paymentId,
      });

      if (!payment) {
        // Optionally match using orderId if you store it
        return res.status(200).json({ received: true });
      }

      payment.status = "paid";
      await payment.save();

      const rc = await RegularClass.findById(payment.regularClassId);
      if (rc) {
        rc.paymentStatus = "paid";
        await rc.save();
      }

      await createAdminNotification(
        "Subscription payment received",
        `Payment ${payment._id} captured`,
        { paymentId: payment._id, regularClassId: payment.regularClassId }
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
