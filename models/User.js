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
    validate: {
      validator: function(v) {
        return !v || /^[0-9]{10}$/.test(v);
      },
      message: props => `${props.value} is not a valid WhatsApp number! Must be 10 digits.`
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
    enum: ['active', 'suspended', 'inactive'],
    default: 'active'
  },
  isDeleted: {
    type: Boolean,
    default: false
  },
  deletedAt: {
    type: Date,
    default: null
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
}, {
  timestamps: true
});

// Pre-save middleware to ensure data consistency
userSchema.pre('save', function(next) {
  // Ensure WhatsApp number is properly formatted
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
userSchema.index({ email: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('User', userSchema);
