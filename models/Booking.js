// models/Booking.js
const mongoose = require('mongoose');

const bookingSchema = new mongoose.Schema(
  {
    studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    tutorId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

    // Demo booking metadata
    subject:       { type: String, required: true, trim: true },
    preferredDate: { type: Date, required: true }, // store as start-of-day (00:00)
    note:          { type: String, trim: true },

    // Flow state
    status: { 
      type: String, 
      enum: ['pending', 'confirmed', 'cancelled', 'completed'], 
      default: 'pending' 
    },
    type: { type: String, enum: ['demo'], default: 'demo' },

    // Meeting (Jitsi on confirm)
    meetingLink: { type: String, default: '' },

    // Student feedback (optional, after completed)
    rating:  { type: Number, min: 1, max: 5 },
    feedback:{ type: String, trim: true },
  },
  { timestamps: true }
);

// 🔒 One demo per (student,tutor,day)
bookingSchema.index(
  { studentId: 1, tutorId: 1, preferredDate: 1, type: 1 },
  { unique: true }
);

module.exports = mongoose.models.Booking || mongoose.model('Booking', bookingSchema);
