const mongoose = require('mongoose');
const { Schema } = mongoose;

const SubscriptionIntentSchema = new Schema(
  {
    studentId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    tutorId:   { type: Schema.Types.ObjectId, ref: 'User', required: true },

    planType:        { type: String, enum: ['monthly'], default: 'monthly' },
    sessionsPerWeek: { type: Number, default: 2 },
    subject:         { type: String, default: '' },

    amount:   { type: Number, required: true }, // rupees
    currency: { type: String, default: 'INR' },

    orderId: { type: String, required: true, index: true }, // Razorpay order_id

    status: { type: String, enum: ['pending','consumed','cancelled'], default: 'pending' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('SubscriptionIntent', SubscriptionIntentSchema);
