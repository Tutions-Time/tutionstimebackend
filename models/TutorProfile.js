const mongoose = require("mongoose");

// Prevent model overwrite in dev environments
if (mongoose.models.TutorProfile) delete mongoose.models.TutorProfile;

const tutorProfileSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
    },

    // Basic info
    name: { type: String, required: true, trim: true },
    email: { type: String, trim: true, lowercase: true },
    gender: { type: String, enum: ["Male", "Female", "Other"] },
    rating: { type: Number, min: 0, max: 5, default: 0 },
    isFeatured: { type: Boolean, default: false },
    lastLogin: { type: Date, default: Date.now },

    // Qualification & Experience
    qualification: { type: String, trim: true },
    specialization: { type: String, trim: true },

    // 🧩 experience as Number — for numeric range filtering
    experience: { type: Number, min: 0 },

    teachingMode: {
      type: String,
      enum: ["Online", "Offline", "Both"],
      default: "Both",
    },
    tuitionType: {
      type: String,
      enum: ["At Student Home", "At Tutor Home", "At Institute", "Online", ""],
      default: "",
    },

    // Location
    city: { type: String, trim: true },
    pincode: { type: String, trim: true },

    // Academics
    subjects: [String],
    classLevels: [String],
    boards: [String],
    exams: [String],
    studentTypes: [String],
    groupSize: { type: String },

    // Rates
    hourlyRate: { type: Number, min: 0 },
    monthlyRate: { type: Number, min: 0, default: 0 },

    // Availability
    availability: [String],

    // Description
    bio: { type: String, trim: true },
    achievements: { type: String, trim: true },

    // Media
    photoUrl: { type: String },
    resumeUrl: { type: String },
    demoVideoUrl: { type: String },

    // Location
    addressLine1: { type: String, trim: true },
    addressLine2: { type: String, trim: true },
    city: { type: String, trim: true },
    state: { type: String, trim: true },
    pincode: { type: String, trim: true },

    // KYC and Verification
    aadhaarUrls: [String],
    panUrl: { type: String },
    bankProofUrl: { type: String },
    kycStatus: {
      type: String,
      enum: ["pending", "submitted", "approved", "rejected"],
      default: "pending",
    },
    status: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "pending",
    },


    // Verification
    isVerified: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// ✅ Index for faster search queries
tutorProfileSchema.index({ city: 1, subjects: 1 });
tutorProfileSchema.index({ hourlyRate: 1 });
tutorProfileSchema.index({ experience: 1 });
tutorProfileSchema.index({ lastLogin: -1 });
tutorProfileSchema.index({ isFeatured: -1 });



module.exports =
  mongoose.models.TutorProfile ||
  mongoose.model("TutorProfile", tutorProfileSchema);
