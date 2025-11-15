// models/Booking.js
const mongoose = require('mongoose');

const feedbackSchema = new mongoose.Schema(
  {
    teaching: { type: Number, min: 1, max: 5, required: true },
    communication: { type: Number, min: 1, max: 5, required: true },
    understanding: { type: Number, min: 1, max: 5, required: true },
    overall: { type: Number, min: 1, max: 5, required: true },
    comment: { type: String, trim: true },
    likedTutor: { type: Boolean, required: true },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

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

    // Demo booking metadata
    subject: { type: String, required: true, trim: true },
    preferredDate: { type: Date, required: true },
    preferredTime: { type: String },
    preferredEndTime: { type: String },
    note: { type: String, trim: true },
    requestedBy: {
      type: String,
      enum: ['student', 'tutor'],
      default: 'student', // existing bookings are student-initiated
    },


    // Flow state
    status: {
      type: String,
      enum: ['pending', 'confirmed', 'cancelled', 'completed'],
      default: 'pending',
    },
    type: { type: String, enum: ['demo'], default: 'demo' },

    // Meeting (Jitsi on confirm)
    meetingLink: { type: String, default: '' },

    // Structured demo feedback
    demoFeedback: feedbackSchema,

    // Link to regular class if upgraded
    regularClassId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'RegularClass',
    },
  },
  { timestamps: true }
);

// 🔒 One demo per (student, tutor, date, time) slot
bookingSchema.index(
  { studentId: 1, tutorId: 1, preferredDate: 1, preferredTime: 1, type: 1 },
  { unique: true }
);

module.exports =
  mongoose.models.Booking || mongoose.model('Booking', bookingSchema);
