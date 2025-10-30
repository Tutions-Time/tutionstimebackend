// models/Availability.js
const { Schema, model, Types } = require('mongoose');

const availabilitySchema = new Schema({
  tutorId:   { type: Types.ObjectId, ref: 'User', required: true },
  startTime: { type: Date, required: true },
  endTime:   { type: Date, required: true },
  isBooked:  { type: Boolean, default: false },
  slotType:  { type: String, enum: ['demo', 'regular'], default: 'demo' },
}, { timestamps: true });

// Prevent duplicate startTime for same tutor
availabilitySchema.index({ tutorId: 1, startTime: 1 }, { unique: true });

module.exports = model('Availability', availabilitySchema);
