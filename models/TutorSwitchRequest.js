const mongoose = require("mongoose");
if (mongoose.models.TutorSwitchRequest) delete mongoose.models.TutorSwitchRequest;

const switchRequestSchema = new mongoose.Schema(
  {
    studentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "StudentProfile",
      required: true,
    },
    fromTutorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "TutorProfile",
      required: true,
    },
    regularClassId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "RegularClass",
    },
    reason: { type: String, required: true },

    status: {
      type: String,
      enum: ["open", "in-progress", "resolved", "cancelled"],
      default: "open",
    },

    // Optional: new assigned tutor
    toTutorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "TutorProfile",
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("TutorSwitchRequest", switchRequestSchema);
