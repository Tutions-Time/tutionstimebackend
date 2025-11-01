// models/Booking.js
const mongoose = require('mongoose');

const bookingSchema = new mongoose.Schema(
  {
    studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    tutorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

    subject: { type: String, required: true },

    date: { type: Date, required: true },
    startTime: { type: Date, required: true },
    endTime: { type: Date, required: true },

    status: { type: String, enum: ['pending', 'confirmed', 'cancelled', 'completed'], default: 'pending' },
    completedAt: { type: Date, default: null },


    // demo vs regular
    type: { type: String, enum: ['demo', 'regular'], required: true },

    amount: { type: Number, min: 0, default: 0 },

    // Zoom fields
    zoomLink: { type: String, default: '' },
    zoomStartUrl: { type: String, default: '' },
    zoomMeetingId: { type: String, default: '' },
    zoomPassword: { type: String, default: '' },
    subscriptionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Subscription',
      default: null,
    },
    

    // payment fields
    paymentStatus: { type: String, enum: ['pending', 'initiated', 'completed', 'failed'], default: 'pending' },
    paymentId: String,

    notes: String,

    rating: { type: Number, min: 1, max: 5 },
    feedback: String,
  },
  { timestamps: true }
);

// Useful indexes
bookingSchema.index({ tutorId: 1, startTime: 1 }); // for tutor timelines
bookingSchema.index({ studentId: 1, startTime: 1 }); // for student timelines

module.exports = mongoose.model('Booking', bookingSchema);
