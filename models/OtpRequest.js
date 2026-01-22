const mongoose = require('mongoose');

const otpRequestSchema = new mongoose.Schema(
  {
    requestId: { type: String, required: true, unique: true },
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    otp: { type: String, required: true },
    purpose: { type: String, enum: ['login', 'signup'], required: true },
    expiresAt: { type: Date, required: true },
    attempts: { type: Number, default: 0 },
  },
  { timestamps: true }
);

otpRequestSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports =
  mongoose.models.OtpRequest || mongoose.model('OtpRequest', otpRequestSchema);
