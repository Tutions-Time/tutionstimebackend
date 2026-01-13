const mongoose = require("mongoose");

const demoAttendanceSchema = new mongoose.Schema(
  {
    bookingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Booking",
      required: true,
      unique: true,
    },
    tutorId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    studentId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    studentJoinedAt: { type: Date, default: null },
    tutorJoinedAt: { type: Date, default: null },
    meetingEndedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

demoAttendanceSchema.index({ bookingId: 1 }, { unique: true });

module.exports =
  mongoose.models.DemoAttendance ||
  mongoose.model("DemoAttendance", demoAttendanceSchema);
