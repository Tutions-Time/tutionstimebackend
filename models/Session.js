const mongoose = require("mongoose");
if (mongoose.models.Session) delete mongoose.models.Session;

const sessionSchema = new mongoose.Schema(
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

    // simple present/absent flag
    attendance: {
      type: String,
      enum: ["present", "absent", "not-marked"],
      default: "not-marked",
    },

    // NEW: more detailed attendance timestamps
    studentJoinTime: { type: Date },
    studentLeaveTime: { type: Date },
    tutorJoinTime: { type: Date },
    tutorLeaveTime: { type: Date },
  
    // NEW: URLs for learning resources
    recordingUrl: { type: String },
    notesUrl: { type: String },
    assignmentUrl: { type: String },

    // NEW: Regular session feedback from student
    sessionFeedback: {
      teaching: { type: Number, min: 1, max: 5 },
      communication: { type: Number, min: 1, max: 5 },
      understanding: { type: Number, min: 1, max: 5 },
      overall: { type: Number, min: 1, max: 5 },
      comment: { type: String, trim: true },
      createdAt: { type: Date },
    },

    // existing
    tutorNotes: { type: String },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Session", sessionSchema);
