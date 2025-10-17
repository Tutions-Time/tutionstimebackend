const mongoose = require('mongoose');

// Clear existing model to avoid schema conflict on reload
if (mongoose.models.TutorProfile) {
  delete mongoose.models.TutorProfile;
}

const tutorProfileSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true
  },
  name: {
    type: String,
    required: true,
    trim: true
  },
  email: {
    type: String,
    trim: true,
    lowercase: true
  },
  gender: {
    type: String,
    enum: ['male', 'female', 'other']
  },
  // Single qualification string (instead of array)
  qualification: {
    type: String,
    trim: true
  },
  // Experience as a descriptive string (e.g., "3–5 years")
  experience: {
    type: String,
    trim: true
  },
  subjects: [{
    type: String
  }],
  classLevels: [{
    type: String
  }],
  teachingMode: {
    type: String,
    enum: ['online', 'offline', 'both'],
    default: 'both'
  },
  hourlyRate: {
    type: Number,
    min: 0
  },
  monthlyRate: {
    type: Number,
    min: 0,
    default: 0
  },
  availableDays: [{
    type: String
  }],
  bio: {
    type: String,
    trim: true
  },
  achievements: {
    type: String,
    trim: true
  },
  photoUrl: {
    type: String
  },
  certificateUrl: {
    type: String
  },
  demoVideoUrl: {
    type: String
  },
  pincode: {
    type: String,
    trim: true
  },
  isVerified: {
    type: Boolean,
    default: false
  }
}, {
  timestamps: true
});
module.exports =
  mongoose.models.TutorProfile ||
  mongoose.model('TutorProfile', tutorProfileSchema);

