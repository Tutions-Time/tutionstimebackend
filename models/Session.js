const mongoose = require("mongoose");
if (mongoose.models.Session) delete mongoose.models.Session;

const sessionSchema = new mongoose.Schema(
  {
    regularClassId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "RegularClass",
      required: true,
    },
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

    // Actual date & time of class
    startDateTime: { type: Date, required: true },

    meetingLink: { type: String },

    status: {
      type: String,
      enum: ["scheduled", "completed", "cancelled"],
      default: "scheduled",
    },

    attendance: {
      type: String,
      enum: ["present", "absent", "not-marked"],
      default: "not-marked",
    },

    tutorNotes: { type: String },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Session", sessionSchema);
