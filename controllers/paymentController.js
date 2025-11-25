const crypto = require("crypto");
const razorpay = require("../services/payments/razorpay"); 
const Payment = require("../models/Payment");
const RegularClass = require("../models/RegularClass");
const TutorProfile = require("../models/TutorProfile");
const StudentProfile = require("../models/StudentProfile");
const { createAdminNotification } = require("../services/adminNotification");
const walletService = require("../services/payments/walletService");
const { default: mongoose } = require("mongoose");

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
      }

      // Wallet updates: Admin hold and Tutor pending credit
      try {
        const commissionPercent = 25;
        const commissionAmount = (amount * commissionPercent) / 100;
        const tutorNetAmount = amount - commissionAmount;

        // Admin receives full amount and holds tutor's share
        await walletService.adminCredit(amount, "Subscription payment captured", { type: "booking", id: payment.regularClassId });
        await walletService.adminIncreaseHold(tutorNetAmount);

        // Tutor sees locked credit immediately (resolve userId from tutor profile)
        const tutorProf = await TutorProfile.findById(rc.tutorId).select('userId');
        const studentProf = await StudentProfile.findById(rc.studentId).select('userId');
        await walletService.creditPending(tutorProf?.userId || rc.tutorId, "tutor", tutorNetAmount, "Payment received for class (locked)", { type: "booking", id: payment.regularClassId });

        // Student wallet history (virtual debit) using userId
        await walletService.addTransaction({
          userId: studentProf?.userId || rc.studentId,
          type: "debit",
          amount,
          description: "Payment for regular class",
          reference: { type: "booking", id: payment.regularClassId },
          status: "completed",
          regularClassId: payment.regularClassId,
          paymentId: payment._id,
        });

        // Schedule release after 30 days of period end (or startDate)
        const baseDate = rc.currentPeriodEnd || rc.startDate || new Date();
        const releaseAt = new Date(baseDate.getTime() + 30 * 24 * 60 * 60 * 1000);
        payment.releaseAt = releaseAt;
        await payment.save();
      } catch (walletErr) {
        console.error("Wallet update error:", walletErr.message);
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

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("Webhook ERR", err);
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
    const { orderId, paymentId, signature, regularClassId, billingType, numberOfClasses } = req.body;

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
      const amount = payment.amount || 0;
      const commissionPercent = 25;
      const commissionAmount = (amount * commissionPercent) / 100;
      const tutorNetAmount = amount - commissionAmount;

      // Admin receives full amount and holds tutor's share
      await walletService.adminCredit(amount, "Subscription payment verified", { type: "booking", id: payment.regularClassId });
      await walletService.adminIncreaseHold(tutorNetAmount);

      // Tutor sees locked credit
      const rc = await RegularClass.findById(rcId);
      if (rc) {
        const tutorProf = await TutorProfile.findById(rc.tutorId).select('userId');
        const studentProf = await StudentProfile.findById(rc.studentId).select('userId');
        await walletService.creditPending(tutorProf?.userId || rc.tutorId, "tutor", tutorNetAmount, "Payment received for class (locked)", { type: "booking", id: payment.regularClassId });

        // Student wallet history
        await walletService.addTransaction({
          userId: studentProf?.userId || rc.studentId,
          type: "debit",
          amount,
          description: "Payment for regular class",
          reference: { type: "booking", id: payment.regularClassId },
          status: "completed",
          regularClassId: payment.regularClassId,
          paymentId: payment._id,
        });

        const baseDate = rc.currentPeriodEnd || rc.startDate || new Date();
        const releaseAt = new Date(baseDate.getTime() + 30 * 24 * 60 * 60 * 1000);
        payment.releaseAt = releaseAt;
        await payment.save();
      }
    } catch (walletErr) {
      console.error("Wallet update error:", walletErr.message);
    }
    }

    await createAdminNotification(
      "Subscription payment verified",
      `Payment ${payment._id} verified via client callback`,
      {
        paymentId: payment._id,
        regularClassId: payment.regularClassId,
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
      .lean();

    res.json({ success: true, data: payouts });
  } catch (err) {
    console.error("listTutorPayouts error:", err);
    res.status(500).json({ success: false, message: "Server error", error: err.message });
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
      .populate({ path: "regularClassId", select: "studentId tutorId subject planType classCount" })
      .lean();

    const data = [];
    for (const p of payments) {
      let studentName = "Student";
      let tutorName = "Tutor";

      const rc = p.regularClassId || null;
      let studentProfile = null;
      let tutorProfile = null;

      if (rc?.studentId) {
        studentProfile = await StudentProfile.findById(rc.studentId).select("name userId");
        if (!studentProfile) {
          studentProfile = await StudentProfile.findOne({ userId: rc.studentId }).select("name userId");
        }
        if (studentProfile?.name) studentName = studentProfile.name;
      }

      if (rc?.tutorId) {
        tutorProfile = await TutorProfile.findById(rc.tutorId).select("name userId");
        if (!tutorProfile) {
          tutorProfile = await TutorProfile.findOne({ userId: rc.tutorId }).select("name userId");
        }
        if (tutorProfile?.name) tutorName = tutorProfile.name;
      }

      data.push({
        _id: p._id,
        amount: p.amount,
        currency: p.currency,
        status: p.status,
        gateway: p.gateway,
        gatewayOrderId: p.gatewayOrderId,
        gatewayPaymentId: p.gatewayPaymentId,
        createdAt: p.createdAt,
        studentName,
        tutorName,
        subject: rc?.subject || "",
        planType: rc?.planType || "",
        classCount: rc?.classCount || null,
      });
    }

    res.json({ success: true, data });
  } catch (err) {
    console.error("listSubscriptionPayments error:", err);
    res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};
