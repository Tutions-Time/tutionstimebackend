const mongoose = require('mongoose');

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
  qualifications: [{
    type: String
  }],
  experience: {
    type: Number,
    min: 0
  },
  subjects: [{
    type: String
  }],
  hourlyRate: {
    type: Number,
    min: 0
  },
  isVerified: {
    type: Boolean,
    default: false
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('TutorProfile', tutorProfileSchema);