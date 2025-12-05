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
 * GROUP BATCH: Create Razorpay ORDER for a reserved seat
 * POST /api/payments/group/create-order
 * Body: { batchId, reservationId }
 * Flow: Ensure active hold exists for this student → create order → persist Payment(type="group")
 */
exports.createGroupOrder = async (req, res) => {
  try {
    const { batchId, reservationId } = req.body;
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

    const amountInPaise = Math.round(Number(gb.pricePerStudent || 0) * 100);
    const safeReceipt = `gb_${Math.random().toString(36).substring(2, 10)}`;
    const order = await razorpay.orders.create({
      amount: amountInPaise,
      currency: "INR",
      receipt: safeReceipt,
      notes: { batchId: batchId.toString().slice(-8), studentId: sp._id.toString().slice(-8) },
    });

    const paymentDoc = await Payment.create({
      type: "group",
      groupBatchId: gb._id,
      studentId: sp._id,
      tutorId: gb.tutorId,
      amount: Number(gb.pricePerStudent || 0),
      currency: "INR",
      gateway: "razorpay",
      gatewayOrderId: order.id,
      status: "created",
      notes: `Group batch checkout for ${batchId}`,
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
    const { noteId } = req.body;
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

    const amountInPaise = Math.round(Number(note.price) * 100);

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
      },
    });

    const paymentDoc = await Payment.create({
      type: "note",
      noteId: note._id,
      studentId,
      tutorId: note.tutorId,
      amount: Number(note.price),
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
            await walletService.addTransaction({
              userId: studentUserId,
              type: "debit",
              amount,
              description: `Payment for regular class — Tutor: ${tp?.name || "Tutor"}`,
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
            await walletService.addTransaction({
              userId: studentUserId,
              type: "debit",
              amount: amt,
              description: `Payment for note — Tutor: ${tp?.name || "Tutor"}`,
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
            await walletService.addTransaction({
              userId: studentUserId,
              type: "debit",
              amount,
              description: `Payment for regular class — Tutor: ${tp?.name || "Tutor"}`,
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
          }
        }
      } catch (walletErr) {
        console.error("Wallet update error:", walletErr.message);
      }
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
        const studentUserId = sp2?.userId || sp._id;
        await walletService.creditPending(
          tutorUserId,
          "tutor",
          tutorNetAmount,
          `Payment received for group batch (locked) — Student: ${sp2?.name || "Student"}`,
          { type: "group", id: gb._id }
        );
        await walletService.addTransaction({
          userId: studentUserId,
          type: "debit",
          amount,
          description: `Payment for group batch — Tutor: ${tp2?.name || "Tutor"}`,
          reference: { type: "group", id: gb._id },
          status: "completed",
          paymentId: payment._id,
        });

        const baseDate = new Date();
        const releaseAt = new Date(baseDate.getTime() + 30 * 24 * 60 * 60 * 1000);
        payment.releaseAt = releaseAt;
        payment.walletProcessed = true;
        await payment.save();
      }
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

// Admin: combined payment history (subscription + note + group)
exports.listAllPaymentsHistory = async (req, res) => {
  try {
    const { from, to } = req.query;
    const range = (q = {}) => {
      if (from || to) {
        q.createdAt = {};
        if (from) q.createdAt.$gte = new Date(from);
        if (to) q.createdAt.$lte = new Date(to);
      }
      return q;
    };

    const subs = await Payment.find(range({ type: "subscription" }))
      .sort({ createdAt: -1 })
      .populate({ path: "studentId", select: "name" })
      .populate({ path: "tutorId", select: "name" })
      .populate({ path: "regularClassId", select: "subject planType classCount" })
      .lean();

    const notes = await Payment.find(range({ type: "note" }))
      .sort({ createdAt: -1 })
      .populate({ path: "studentId", select: "name" })
      .populate({ path: "tutorId", select: "name" })
      .populate({ path: "noteId", select: "title" })
      .lean();

    const groups = await Payment.find(range({ type: "group" }))
      .sort({ createdAt: -1 })
      .populate({ path: "studentId", select: "name" })
      .populate({ path: "tutorId", select: "name" })
      .populate({ path: "groupBatchId", select: "subject level" })
      .lean();

    const mapSub = subs.map((p) => ({
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
      subject: p.regularClassId?.subject || "",
      planType: p.regularClassId?.planType || "",
      classCount: p.regularClassId?.classCount || null,
    }));

    const mapNote = notes.map((p) => ({
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
      noteTitle: p.noteId?.title || "",
    }));

    const mapGroup = groups.map((p) => ({
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
      subject: p.groupBatchId?.subject || "",
    }));

    const combined = [...mapSub, ...mapNote, ...mapGroup].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json({ success: true, data: combined });
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
      .populate({ path: "tutorId", select: "name" })
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
    }));

    res.json({ success: true, data });
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
