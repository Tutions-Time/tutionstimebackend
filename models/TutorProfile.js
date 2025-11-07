const mongoose = require("mongoose");

if (mongoose.models.TutorProfile) delete mongoose.models.TutorProfile;

const tutorProfileSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, unique: true },
    name: { type: String, required: true, trim: true },
    email: { type: String, trim: true, lowercase: true },
    gender: { type: String, enum: ["Male", "Female", "Other"] },

    qualification: { type: String, trim: true },
    specialization: { type: String, trim: true },
    experience: { type: String, trim: true },
    teachingMode: { type: String, enum: ["Online", "Offline", "Both"], default: "Both" },

    subjects: [String],
    classLevels: [String],
    boards: [String],
    exams: [String],
    studentTypes: [String],
    groupSize: { type: String },

    hourlyRate: { type: Number, min: 0 },
    monthlyRate: { type: Number, min: 0, default: 0 },
    availability: [String],

    bio: { type: String, trim: true },
    achievements: { type: String, trim: true },

    photoUrl: { type: String },
    resumeUrl: { type: String },
    demoVideoUrl: { type: String },
    pincode: { type: String, trim: true },

    isVerified: { type: Boolean, default: false },
  },
  { timestamps: true }
);

module.exports =
  mongoose.models.TutorProfile || mongoose.model("TutorProfile", tutorProfileSchema);
