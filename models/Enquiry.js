// models/Enquiry.js
const mongoose = require('mongoose');

const enquirySchema = new mongoose.Schema(
  {
    studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    tutorId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

    subject: { type: String, required: true, trim: true },
    message: { type: String, required: true, trim: true },

    // Simple status & optional reply
    status: { type: String, enum: ['open', 'replied', 'closed'], default: 'open' },
    reply:  { type: String, trim: true }, // tutor’s reply
  },
  { timestamps: true }
);

// Useful filters
enquirySchema.index({ tutorId: 1, createdAt: -1 });
enquirySchema.index({ studentId: 1, createdAt: -1 });

module.exports = mongoose.models.Enquiry || mongoose.model('Enquiry', enquirySchema);
