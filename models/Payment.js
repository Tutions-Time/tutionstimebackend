const mongoose = require("mongoose");
if (mongoose.models.Payment) delete mongoose.models.Payment;

const paymentSchema = new mongoose.Schema(
  {
    regularClassId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "RegularClass",
    },
    groupBatchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "GroupBatch",
    },
    studentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "StudentProfile",
    },
    tutorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "TutorProfile",
    },

    // "subscription" = student pays admin for classes
    // "payout"      = admin pays tutor
    // "note"        = student buys paid note
    type: {
      type: String,
      enum: ["subscription", "payout", "note", "group"],
      required: true,
    },

    // Razorpay order/subscription/payment IDs etc.
    gateway: { type: String, default: "razorpay" },
    gatewayOrderId: { type: String },
    gatewayPaymentId: { type: String },

    // Amount details
    amount: { type: Number, required: true }, // full amount
    currency: { type: String, default: "INR" },

    // For note purchases
    noteId: { type: mongoose.Schema.Types.ObjectId, ref: "Note" },

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

  // Payout tracking for subscriptions
  payoutGenerated: { type: Boolean, default: false },
  payoutId: { type: mongoose.Schema.Types.ObjectId, ref: "Payment" },
  releaseAt: { type: Date },

  walletProcessed: { type: Boolean, default: false },

    notes: { type: String },
    refundTotal: { type: Number, default: 0 },
    refunds: [{ type: mongoose.Schema.Types.ObjectId, ref: "RefundRequest" }],
  },
  { timestamps: true }
);

module.exports = mongoose.model("Payment", paymentSchema);
