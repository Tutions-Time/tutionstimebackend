// services/payments/razorpay.js
const Razorpay = require('razorpay');
const enabled = !!(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);

const client = enabled
  ? new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET })
  : null;

async function createOrder({ amountInPaise, receipt }) {
  if (!enabled) {
    return { id: `test_${Date.now()}`, amount: amountInPaise, currency: 'INR', status: 'created', receipt };
  }
  return client.orders.create({ amount: amountInPaise, currency: 'INR', receipt });
}

module.exports = { createOrder };
