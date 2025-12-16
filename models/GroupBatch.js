const mongoose = require("mongoose");
if (mongoose.models.GroupBatch) delete mongoose.models.GroupBatch;

const holdSchema = new mongoose.Schema(
  {
    studentId: { type: mongoose.Schema.Types.ObjectId, ref: "StudentProfile", required: true },
    orderId: { type: String },
    expiresAt: { type: Date, required: true },
    status: { type: String, enum: ["active", "released", "finalized"], default: "active" }
  },
  { _id: false }
);

const scheduleRecurringSchema = new mongoose.Schema(
  {
    days: [{ type: String, enum: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] }],
    time: { type: String },
    startDate: { type: Date },
    endDate: { type: Date }
  },
  { _id: false }
);

const groupBatchSchema = new mongoose.Schema(
  {
    tutorId: { type: mongoose.Schema.Types.ObjectId, ref: "TutorProfile", required: true },
    subject: { type: String, required: true },
    level: { type: String },
    batchType: { type: String, enum: ["revision", "exam"], required: true },
    scheduleType: { type: String, enum: ["fixed", "recurring"], required: true },
    fixedDates: [{ type: Date }],
    recurring: scheduleRecurringSchema,
    seatCap: { type: Number, required: true },
    pricePerStudent: { type: Number, required: true },
  meetingLink: { type: String },
  accessWindow: {
    joinBeforeMin: { type: Number, default: 5 },
    expireAfterMin: { type: Number, default: 5 }
  },
  description: { type: String },
  published: { type: Boolean, default: false },
  status: { type: String, enum: ["active", "cancelled"], default: "active" },
  batchStartDate: { type: Date },
  batchEndDate: { type: Date },
  enrollmentOpenAt: { type: Date },
  enrollmentCloseAt: { type: Date },
  enrolled: [{ type: mongoose.Schema.Types.ObjectId, ref: "StudentProfile" }],
  enrollmentDetails: [
    {
      studentId: { type: mongoose.Schema.Types.ObjectId, ref: "StudentProfile" },
      validUntil: { type: Date },
      joinedAt: { type: Date, default: Date.now }
    }
  ],
  holds: [holdSchema],
  waitlist: [{ type: mongoose.Schema.Types.ObjectId, ref: "StudentProfile" }]
  },
  { timestamps: true }
);

module.exports = mongoose.model("GroupBatch", groupBatchSchema);
