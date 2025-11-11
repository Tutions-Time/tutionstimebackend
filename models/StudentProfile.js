const mongoose = require("mongoose");

const isoDateRegex = /^\d{4}-\d{2}-\d{2}$/;

const studentProfileSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
    },

    // Personal Info
    name: { type: String, required: true, trim: true },
    email: { type: String, trim: true, lowercase: true },
    gender: {
      type: String,
      enum: ["Male", "Female", "Other", ""],
      default: "",
    },

    // Address
    city: { type: String, trim: true },
    state: { type: String, trim: true },
    pincode: { type: String, trim: true },

    // Academic Preferences
    board: { type: String, trim: true },
    classLevel: { type: String, trim: true },
    subjects: [String],

    // Tutor Preference
    tutorGenderPref: {
      type: String,
      enum: ["Male", "Female", "No Preference", "Other", ""],
      default: "No Preference",
    },

    // Learning Goals
    goals: { type: String, trim: true },

    // Availability (date strings)
    availability: {
      type: [String],
      default: [],
      validate: {
        validator: (arr) =>
          Array.isArray(arr) && arr.every((d) => isoDateRegex.test(d)),
        message: "availability must be an array of YYYY-MM-DD dates",
      },
    },

    // Optional Profile Photo
    photoUrl: { type: String },
  },
  { timestamps: true }
);

module.exports =
  mongoose.models.StudentProfile ||
  mongoose.model("StudentProfile", studentProfileSchema);
