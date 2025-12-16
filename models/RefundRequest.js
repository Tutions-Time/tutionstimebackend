const mongoose = require("mongoose");
if (mongoose.models.RefundRequest) delete mongoose.models.RefundRequest;

const refundSchema = new mongoose.Schema(
  {
    paymentId: { type: mongoose.Schema.Types.ObjectId, ref: "Payment", required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    amount: { type: Number },
    reason: { type: String },
    reasonCode: { type: String, enum: ["CLASS_NOT_CONDUCTED","TUTOR_ABSENT_OR_LATE","WRONG_PURCHASE","QUALITY_ISSUE","TECHNICAL_ISSUE","SCHEDULE_CONFLICT","CONTENT_NOT_AS_DESCRIBED","OTHER"] },
    reasonText: { type: String },
    status: { type: String, enum: ["requested", "approved", "rejected", "processed"], default: "requested" },
    method: { type: String, enum: ["provider", "payout"] },
    providerRefundId: { type: String },
    providerStatus: { type: String },
    processedAt: { type: Date },
    notes: { type: String },
    adminUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    amountApproved: { type: Number },
    completionPercentage: { type: Number },
    refundableCap: { type: Number },
    suggestedAmount: { type: Number }
  },
  { timestamps: true }
);

module.exports = mongoose.model("RefundRequest", refundSchema);
