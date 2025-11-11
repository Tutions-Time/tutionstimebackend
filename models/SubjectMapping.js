const mongoose = require("mongoose");

const SubjectMappingSchema = new mongoose.Schema(
  {
    track: {
      type: String,
      enum: ["school", "college", "competitive"],
      required: true,
    },
    category: {
      type: String,
      enum: ["board", "discipline", "exam", "other"],
      required: true,
    },
    categoryValue: {
      type: String,
      required: true,
      trim: true,
    },
    subjects: {
      type: [String],
      required: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("SubjectMapping", SubjectMappingSchema);
