const mongoose = require('mongoose');
const { Schema } = mongoose;

const SubscriptionSchema = new Schema(
  {
    studentId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    tutorId:   { type: Schema.Types.ObjectId, ref: 'User', required: true },

    planType: { type: String, enum: ['monthly'], required: true },

    amount:   { type: Number, required: true }, // rupees
    currency: { type: String, default: 'INR' },

    status:        { type: String, enum: ['pending','active','expired','cancelled'], default: 'pending' },
    paymentStatus: { type: String, enum: ['initiated','completed','failed','refunded','pending'], default: 'initiated' },

    // Razorpay references
    orderId:   { type: String },
    paymentId: { type: String },

    // Period
    startDate: { type: Date },
    endDate:   { type: Date },

    // Scheduling
    sessionsPerWeek:       { type: Number, default: 2 },
    generatedBookingsCount:{ type: Number, default: 0 },

    // Optional
    subject: { type: String, default: '' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Subscription', SubscriptionSchema);
