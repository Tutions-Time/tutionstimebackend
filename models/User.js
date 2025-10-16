const mongoose = require('mongoose');

// Clear any existing models to prevent schema conflicts
if (mongoose.models.User) {
    delete mongoose.models.User;
}

const userSchema = new mongoose.Schema({
  phone: {
    type: String,
    required: [true, 'Phone number is required'],
    unique: true,
    trim: true,
    validate: {
      validator: function(v) {
        return /^[0-9]{10}$/.test(v);
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
  }
}, {
  timestamps: true
});

// Pre-save middleware to ensure data consistency
userSchema.pre('save', function(next) {
  // Ensure phone number is properly formatted
  if (this.phone) {
    this.phone = this.phone.trim();
  }

  // Additional validation
  if (!this.phone || !/^[0-9]{10}$/.test(this.phone)) {
    next(new Error('Valid phone number is required'));
    return;
  }

  next();
});

// Add index explicitly
userSchema.index({ phone: 1 }, { unique: true });

module.exports = mongoose.model('User', userSchema);