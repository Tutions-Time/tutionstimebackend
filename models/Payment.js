const mongoose = require("mongoose");
if (mongoose.models.Payment) delete mongoose.models.Payment;

const paymentSchema = new mongoose.Schema(
  {
    regularClassId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "RegularClass",
    },
    studentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "StudentProfile",
    },
    tutorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "TutorProfile",
    },

    // "subscription" = student pays admin
    // "payout"      = admin pays tutor
    type: {
      type: String,
      enum: ["subscription", "payout"],
      required: true,
    },

    // Razorpay order/subscription/payment IDs etc.
    gateway: { type: String, default: "razorpay" },
    gatewayOrderId: { type: String },
    gatewayPaymentId: { type: String },

    // Amount details
    amount: { type: Number, required: true }, // full amount
    currency: { type: String, default: "INR" },

    // For payout records
    commissionPercent: { type: Number }, // 25
    commissionAmount: { type: Number },  // 25% of amount
    tutorNetAmount: { type: Number },    // 75% of amount

    // Billing period (for monthly)
    periodStart: { type: Date },
    periodEnd: { type: Date },

    status: {
      type: String,
      enum: ["created", "paid", "failed", "settled"],
      default: "created",
    },

    notes: { type: String },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Payment", paymentSchema);
