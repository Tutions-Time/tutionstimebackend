const Razorpay = require("razorpay");

function notConfigured() {
  const err = new Error("Razorpay not configured");
  err.code = "RAZORPAY_NOT_CONFIGURED";
  throw err;
}

function buildStub() {
  return {
    orders: {
      create: () => notConfigured(),
    },
    payments: {
      refund: () => notConfigured(),
    },
  };
}

function buildClient() {
  const key = process.env.RAZORPAY_KEY_ID;
  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!key || !secret) return buildStub();
  return new Razorpay({ key_id: key, key_secret: secret });
}

module.exports = buildClient();


