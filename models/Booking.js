const mongoose = require('mongoose');

const bookingSchema = new mongoose.Schema(
  {
    studentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    tutorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    subject: {
      type: String,
      required: true,
    },
    date: {
      type: Date,
      required: true,
    },
    startTime: {
      type: Date, 
      required: true,
    },
    endTime: {
      type: Date,
      required: true,
    },
    status: {
      type: String,
      enum: ['pending', 'confirmed', 'cancelled', 'completed'],
      default: 'pending',
    },
    // demo vs regular
    type: {
      type: String,
      enum: ['demo', 'regular'],
      required: true,
    },
    amount: {
      type: Number,
      min: 0,
      default: 0,
    },
    // ✅ Expanded payment status
    paymentStatus: {
      type: String,
      enum: ['pending', 'initiated', 'completed', 'failed'],
      default: 'pending',
    },
    paymentId: String,
    notes: String,
    rating: {
      type: Number,
      min: 1,
      max: 5,
    },
    feedback: String,
  },
  { timestamps: true }
);

module.exports = mongoose.model('Booking', bookingSchema);
