const mongoose = require("mongoose");
if (mongoose.models.SessionAssignment) delete mongoose.models.SessionAssignment;

const sessionAssignmentSchema = new mongoose.Schema(
  {
    sessionId: { type: mongoose.Schema.Types.ObjectId, ref: "Session", required: true },
    regularClassId: { type: mongoose.Schema.Types.ObjectId, ref: "RegularClass", required: true },
    tutorId: { type: mongoose.Schema.Types.ObjectId, ref: "TutorProfile", required: true },
    studentId: { type: mongoose.Schema.Types.ObjectId, ref: "StudentProfile", required: true },

    title: { type: String, required: true },
    description: { type: String, default: "" },
    dueDate: { type: Date },

    tutorFileUrls: { type: [String], default: [] },
    tutorFileKeys: { type: [String], default: [] },

    studentSubmissionUrls: { type: [String], default: [] },
    studentSubmissionKeys: { type: [String], default: [] },

    status: { type: String, enum: ["open", "submitted", "graded"], default: "open" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("SessionAssignment", sessionAssignmentSchema);

