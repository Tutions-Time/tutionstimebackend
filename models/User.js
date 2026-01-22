const mongoose = require('mongoose');

// Clear any existing models to prevent schema conflicts
if (mongoose.models.User) {
    delete mongoose.models.User;
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const userSchema = new mongoose.Schema({
  email: {
    type: String,
    trim: true,
    lowercase: true,
    unique: true,
    sparse: true,
    validate: {
      validator: function(v) {
        return EMAIL_REGEX.test(v);
      },
      message: props => `${props.value} is not a valid email address`
    }
  },
  phone: {
    type: String,
    trim: true,
    sparse: true,
    unique: true,
    validate: {
      validator: function(v) {
        return !v || /^[0-9]{10}$/.test(v);
      },
      message: props => `${props.value} is not a valid phone number! Must be 10 digits.`
    }
  },
  role: {
    type: String,
    enum: ['student', 'tutor', 'admin'],
    required: true
  },
  isProfileComplete: {
    type: Boolean,
    default: false
  },
  status: {
    type: String,
    enum: ['active', 'suspended'],
    default: 'active'
  },
  refreshToken: {
    type: String,
    default: null
  },
  lastLogin: {
    type: Date,
    default: Date.now
  },
  notificationPrefs: {
    email: { type: Boolean, default: true },
    push: { type: Boolean, default: true },
    inapp: { type: Boolean, default: true }
  },
  // Referral fields
  referrerUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  referralCodeUsed: { type: String, default: null },
  referralRewardGranted: { type: Boolean, default: false },
  referralSignupBonusGranted: { type: Boolean, default: false },
  referralStudentRewardGranted: { type: Boolean, default: false }
}, {
  timestamps: true
});

// Pre-save middleware to ensure data consistency
userSchema.pre('save', function(next) {
  // Ensure phone number is properly formatted
  if (this.phone) {
    this.phone = this.phone.trim();
  }

  if (this.email) {
    this.email = String(this.email).trim().toLowerCase();
  }

  if (!this.email || !EMAIL_REGEX.test(this.email)) {
    next(new Error('Valid email address is required'));
    return;
  }

  next();
});

// Add index explicitly
userSchema.index({ phone: 1 }, { unique: true, sparse: true });
userSchema.index({ email: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('User', userSchema);
