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
    altPhone: { type: String, trim: true },
    genderOther: { type: String, trim: true },

    // Address
    addressLine1: { type: String, trim: true },
    addressLine2: { type: String, trim: true },
    city: { type: String, trim: true },
    state: { type: String, trim: true },
    pincode: { type: String, trim: true },
    learningMode: {
      type: String,
      enum: ["Online", "Offline", "Both", ""],
      default: "",
    },

    // Academic Preferences
    track: { type: String, enum: ["school", "college", "competitive", ""], default: "" },
    board: { type: String, trim: true },
    boardOther: { type: String, trim: true },
    classLevel: { type: String, trim: true },
    classLevelOther: { type: String, trim: true },
    stream: { type: String, trim: true },
    streamOther: { type: String, trim: true },
    program: { type: String, trim: true },
    programOther: { type: String, trim: true },
    discipline: { type: String, trim: true },
    disciplineOther: { type: String, trim: true },
    yearSem: { type: String, trim: true },
    yearSemOther: { type: String, trim: true },
    exam: { type: String, trim: true },
    examOther: { type: String, trim: true },
    targetYear: { type: String, trim: true },
    targetYearOther: { type: String, trim: true },
    subjects: [String],
    subjectOther: { type: String, trim: true },

    // Tutor Preference
    tutorGenderPref: {
      type: String,
      enum: ["Male", "Female", "No Preference", "Other", ""],
      default: "No Preference",
    },
    tutorGenderOther: { type: String, trim: true },
    preferredTimes: [String],
    subjectTimeSlots: [
      {
        subject: { type: String, trim: true },
        slots: [{ type: String, trim: true }],
      },
    ],

    // Budget preference
    budget: { type: String, trim: true },

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

    // Refund/Payout details (used for student refund settlements)
    upiId: { type: String, trim: true },
    accountHolderName: { type: String, trim: true },
    bankAccountNumber: { type: String, trim: true },
    ifsc: { type: String, trim: true },
  },
  { timestamps: true }
);

module.exports =
  mongoose.models.StudentProfile ||
  mongoose.model("StudentProfile", studentProfileSchema);
