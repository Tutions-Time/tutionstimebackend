const mongoose = require('mongoose');

if (mongoose.models.DeviceToken) delete mongoose.models.DeviceToken;

const deviceTokenSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    token: { type: String, required: true, unique: true },
    platform: { type: String, enum: ['ios', 'android', 'web'], default: 'web' },
    provider: { type: String, enum: ['fcm', 'onesignal'], default: 'fcm' },
    enabled: { type: Boolean, default: true },
    lastActive: { type: Date, default: Date.now },
    meta: { type: Object, default: {} },
  },
  { timestamps: true }
);

deviceTokenSchema.index({ userId: 1 });

module.exports = mongoose.model('DeviceToken', deviceTokenSchema);

