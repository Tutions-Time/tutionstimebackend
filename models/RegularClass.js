const mongoose = require("mongoose");
if (mongoose.models.RegularClass) delete mongoose.models.RegularClass;

const timeSlotSchema = new mongoose.Schema(
  {
    dayOfWeek: {
      type: String,
      enum: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
      required: true,
    },
    time: { type: String, required: true }, // "18:30"
  },
  { _id: false }
);

const regularClassSchema = new mongoose.Schema(
  {
    studentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "StudentProfile",
      required: true,
    },
    tutorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "TutorProfile",
      required: true,
    },

    subject: { type: String, required: true },

    // Hourly / Weekly / Monthly / Custom
    planType: {
      type: String,
      enum: ["hourly", "weekly", "monthly", "custom"],
      required: true,
    },

    sessionsPerWeek: { type: Number, min: 1, default: 2 },
    timeSlots: [timeSlotSchema], // weekly schedule

    startDate: { type: Date, required: true },

    // Billing
    amount: { type: Number, required: true }, // monthly or package amount
    currency: { type: String, default: "INR" },

    paymentStatus: {
      type: String,
      enum: ["pending", "paid", "failed"],
      default: "pending",
    },

    status: {
      type: String,
      enum: ["active", "paused", "ended"],
      default: "active",
    },

    // Razorpay subscription / order id
    paymentRef: { type: String },

    // For month wise payout
    currentPeriodStart: { type: Date },
    currentPeriodEnd: { type: Date },
  },
  { timestamps: true }
);

module.exports = mongoose.model("RegularClass", regularClassSchema);
