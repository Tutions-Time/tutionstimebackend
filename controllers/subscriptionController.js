const crypto = require('crypto');
const dayjs = require('dayjs');

const SubscriptionIntent = require('../models/SubscriptionIntent');
const Subscription       = require('../models/Subscription');
const Booking            = require('../models/Booking');
const Availability       = require('../models/Availability');
const TutorProfile       = require('../models/TutorProfile');
const StudentProfile     = require('../models/StudentProfile');

const { createOrder }    = require('../services/payments/razorpay');
const notificationService= require('../services/notificationService');

const WEEKS = 4;

/**
 * STEP 1 — Create Razorpay order and save a SubscriptionIntent.
 * No DB Subscription is created here.
 */
exports.createCheckout = async (req, res) => {
  try {
    const { tutorId, planType = 'monthly', sessionsPerWeek = 2, subject = '' } = req.body;

    if (!tutorId) {
      return res.status(400).json({ success: false, message: 'tutorId is required' });
    }

    // Price from tutor profile
    const tutor = await TutorProfile.findOne({ userId: tutorId }).lean();
    if (!tutor || !tutor.monthlyRate) {
      return res.status(400).json({ success: false, message: 'Tutor or monthly rate not found' });
    }

    const rupeeAmount   = Math.max(tutor.monthlyRate, 1); // Rupees
    const amountInPaise = rupeeAmount * 100;

    const shortTutorId = tutorId.toString().slice(-6);
    const order = await createOrder({
      amountInPaise,
      receipt: `SUB-${shortTutorId}-${Date.now()}`
    });

    // Save intent so we don't trust client meta later
    await SubscriptionIntent.create({
      studentId: req.user.id,
      tutorId,
      planType,
      sessionsPerWeek,
      subject,
      amount: rupeeAmount,
      currency: 'INR',
      orderId: order.id,
      status: 'pending',
    });

    return res.status(200).json({
      success: true,
      message: 'Order created successfully',
      order
    });
  } catch (err) {
    console.error('createCheckout error:', err);
    return res.status(500).json({ success: false, message: 'Failed to create subscription order' });
  }
};


/**
 * STEP 2 — Verify Razorpay signature, activate subscription, create bookings,
 * and handle wallet + notifications.
 */
exports.verifyAndActivate = async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    const walletService = require("../services/payments/walletService");

    // 1️⃣ Verify Razorpay signature
    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(razorpay_order_id + "|" + razorpay_payment_id)
      .digest("hex");

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ success: false, message: "Payment verification failed" });
    }

    // 2️⃣ Find SubscriptionIntent
    const intent = await SubscriptionIntent.findOne({
      orderId: razorpay_order_id,
      studentId: req.user.id,
      status: "pending",
    });

    if (!intent) {
      return res.status(404).json({ success: false, message: "Pending subscription intent not found" });
    }

    // 3️⃣ Create Subscription (payment success)
    const sub = await Subscription.create({
      studentId: intent.studentId,
      tutorId: intent.tutorId,
      planType: intent.planType,
      amount: intent.amount,
      currency: intent.currency,
      status: "active",
      paymentStatus: "completed",
      orderId: razorpay_order_id,
      paymentId: razorpay_payment_id,
      startDate: new Date(),
      endDate: dayjs().add(1, "month").toDate(),
      sessionsPerWeek: intent.sessionsPerWeek,
      subject: intent.subject,
    });

    // 4️⃣ Generate upcoming bookings (4 weeks)
    const until = dayjs().add(WEEKS, "week").toDate();
    const slots = await Availability.find({
      tutorId: sub.tutorId,
      slotType: "regular",
      isBooked: false,
      startTime: { $gte: sub.startDate, $lte: until },
    }).sort({ startTime: 1 });

    const totalToCreate = sub.sessionsPerWeek * WEEKS;
    const chosenSlots = slots.slice(0, totalToCreate);
    const perClassAmount = Math.round((sub.amount / Math.max(chosenSlots.length, 1)) * 100) / 100;

    let created = 0;
    for (const s of chosenSlots) {
      await Booking.create({
        studentId: sub.studentId,
        tutorId: sub.tutorId,
        subject: sub.subject || "Regular Class",
        date: s.startTime,
        startTime: s.startTime,
        endTime: s.endTime,
        type: "regular",
        amount: perClassAmount,
        status: "confirmed",
        paymentStatus: "completed",
        subscriptionId: sub._id,
      });
      await Availability.updateOne({ _id: s._id }, { $set: { isBooked: true } });
      created++;
    }

    sub.generatedBookingsCount = created;
    await sub.save();

    // 5️⃣ Mark intent as consumed
    intent.status = "consumed";
    await intent.save();

    // 6️⃣ Wallet Transactions — Student Debit & Tutor Credit (with proper transaction history)
    try {
      const tutorProfile = await TutorProfile.findOne({ userId: sub.tutorId }).lean();
      const studentProfile = await StudentProfile.findOne({ userId: sub.studentId }).lean();

      const tutorName = tutorProfile?.name || "Tutor";
      const studentName = studentProfile?.name || "Student";

      const tutorId = sub.tutorId;
      const studentId = sub.studentId;
      const debitAmount = sub.amount; // Student pays full
      const creditAmount = Math.round(sub.amount * 0.9 * 100) / 100; // Tutor gets 90%

      // 💳 1️⃣ Debit Student Wallet (record transaction)
      await walletService.debitWallet(
        studentId,
        "student",
        debitAmount,
        `Payment to ${tutorName} for monthly subscription`,
        sub._id.toString()
      );

      // 💰 2️⃣ Credit Tutor Wallet (record transaction)
      await walletService.creditWallet(
        tutorId,
        "tutor",
        creditAmount,
        `Received from ${studentName} for monthly subscription`,
        sub._id.toString()
      );

      console.log(
        `✅ Wallets updated: Student debited ₹${debitAmount}, Tutor credited ₹${creditAmount}`
      );
    } catch (walletErr) {
      console.error("⚠️ Wallet transaction error:", walletErr.message);
    }

    // 7️⃣ Notify Student via Email
    const student = await StudentProfile.findOne({ userId: sub.studentId }).lean();
    const tutor = await TutorProfile.findOne({ userId: sub.tutorId }).lean();

    if (student?.email) {
      await notificationService.sendEmail(
        student.email,
        "Subscription Activated",
        `Your monthly subscription with ${tutor?.name || "the tutor"} is now active. ${created} classes have been scheduled for this month.`
      );
    }

    return res.status(200).json({
      success: true,
      message: "Subscription verified, activated & both wallets updated successfully",
      subscription: sub,
    });
  } catch (err) {
    console.error("verifyAndActivate error:", err);
    return res.status(500).json({ success: false, message: "Failed to verify subscription" });
  }
};


/**
 * STEP 3 — Fetch subscriptions for logged-in student
 */
exports.getMySubscriptions = async (req, res) => {
  try {
    const subs = await Subscription.find({ studentId: req.user.id }).sort({ createdAt: -1 });
    return res.status(200).json({ success: true, data: subs });
  } catch (err) {
    console.error('getMySubscriptions error:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch subscriptions' });
  }
};
