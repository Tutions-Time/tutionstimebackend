const mongoose = require("mongoose");
if (mongoose.models.RescheduleRequest) delete mongoose.models.RescheduleRequest;

const rescheduleRequestSchema = new mongoose.Schema(
  {
    sessionId: { type: mongoose.Schema.Types.ObjectId, ref: "Session", required: true, index: true },
    groupBatchId: { type: mongoose.Schema.Types.ObjectId, ref: "GroupBatch", required: true },
    proposedStartDateTime: { type: Date, required: true },
    reason: { type: String },
    requesterUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    requesterRole: { type: String, enum: ["student", "tutor"], required: true },
    status: { type: String, enum: ["pending", "approved", "rejected", "cancelled"], default: "pending", index: true },
    approverUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    approverRole: { type: String, enum: ["student", "tutor"] },
    decisionAt: { type: Date },
  },
  { timestamps: true }
);

module.exports = mongoose.model("RescheduleRequest", rescheduleRequestSchema);

