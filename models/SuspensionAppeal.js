const mongoose = require('mongoose');

const suspensionAppealSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    role: { type: String, enum: ['student', 'tutor'], required: true },
    status: { type: String, enum: ['open', 'replied', 'closed'], default: 'open', index: true },
    reason: { type: String, required: true, trim: true },
    explanation: { type: String, trim: true, default: '' },
    adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    userReply: { type: String, trim: true, default: '' },
    repliedAt: { type: Date },
  },
  { timestamps: true }
);

module.exports =
  mongoose.models.SuspensionAppeal ||
  mongoose.model('SuspensionAppeal', suspensionAppealSchema);
