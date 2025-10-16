const mongoose = require('mongoose');

const studentProfileSchema = new mongoose.Schema({
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
    enum: ['Male', 'female', 'other']
  },
  classLevel: {
    type: String,
    required: true
  },
  subjects: [{
    type: String
  }],
  goals: {
    type: String
  },
  pincode: {
    type: String,
    trim: true
  },
  photoUrl: {
    type: String
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('StudentProfile', studentProfileSchema);