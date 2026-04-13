const crypto = require("crypto");
const Razorpay = require("razorpay");

function providerError(message, code = "RAZORPAY_NOT_CONFIGURED") {
  const err = new Error(message);
  err.code = code;
  return err;
}

function getCredentials() {
  const keyId = process.env.RAZORPAY_KEY_ID || "";
  const keySecret = process.env.RAZORPAY_KEY_SECRET || "";

  if (!keyId || !keySecret) {
    throw providerError("Razorpay payments not configured");
  }

  return { keyId, keySecret };
}

function client() {
  const { keyId, keySecret } = getCredentials();
  return new Razorpay({
    key_id: keyId,
    key_secret: keySecret,
  });
}

function normalizeOrder(order = {}) {
  return {
    ...order,
    id: order.id,
    amount: order.amount,
    currency: order.currency || "INR",
    status: order.status,
  };
}

async function createOrder(payload = {}) {
  const amount = Number(payload.amount || 0);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw providerError("Invalid order amount", "RAZORPAY_INVALID_AMOUNT");
  }

  const order = await client().orders.create({
    amount,
    currency: payload.currency || "INR",
    receipt: payload.receipt,
    notes: payload.notes || {},
  });

  return normalizeOrder(order);
}

async function fetchOrder(orderId) {
  if (!orderId) throw providerError("Missing order id", "RAZORPAY_MISSING_ORDER");
  return normalizeOrder(await client().orders.fetch(orderId));
}

async function fetchOrderPayments(orderId) {
  if (!orderId) return [];
  const response = await client().orders.fetchPayments(orderId);
  return Array.isArray(response?.items) ? response.items : [];
}

async function refund(paymentId, amountInPaise, meta = {}) {
  if (!paymentId) throw providerError("Missing payment id", "RAZORPAY_MISSING_PAYMENT");
  return client().payments.refund(paymentId, {
    amount: Number(amountInPaise || 0),
    notes: meta || {},
  });
}

function verifyPaymentSignature(orderId, paymentId, signature) {
  const { keySecret } = getCredentials();
  if (!orderId || !paymentId || !signature) return false;
  const expected = crypto
    .createHmac("sha256", keySecret)
    .update(`${orderId}|${paymentId}`)
    .digest("hex");
  return expected === signature;
}

function verifyWebhookSignature(signature, rawBody) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET || "";
  if (!signature || !rawBody || !secret) return false;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");
  return expected === signature;
}

module.exports = {
  orders: {
    create: createOrder,
    fetch: fetchOrder,
    fetchPayments: fetchOrderPayments,
  },
  payments: {
    refund,
  },
  getKeyId: () => getCredentials().keyId,
  verifyPaymentSignature,
  verifyWebhookSignature,
};
