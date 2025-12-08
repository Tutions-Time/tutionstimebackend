const mongoose = require("mongoose");
if (mongoose.models.RefundRequest) delete mongoose.models.RefundRequest;

const refundSchema = new mongoose.Schema(
  {
    paymentId: { type: mongoose.Schema.Types.ObjectId, ref: "Payment", required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    amount: { type: Number, required: true },
    reason: { type: String },
    status: { type: String, enum: ["requested", "approved", "rejected", "processed"], default: "requested" }
  },
  { timestamps: true }
);

module.exports = mongoose.model("RefundRequest", refundSchema);
