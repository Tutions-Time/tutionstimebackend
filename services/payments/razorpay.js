const axios = require("axios");
const crypto = require("crypto");

const CASHFREE_API_VERSION = process.env.CASHFREE_API_VERSION || "2023-08-01";

function providerError(message, code = "CASHFREE_NOT_CONFIGURED") {
  const err = new Error(message);
  err.code = code;
  return err;
}

function resolveMode() {
  const rawMode = String(
    process.env.CASHFREE_ENV ||
      process.env.CASHFREE_MODE ||
      process.env.NODE_ENV ||
      "sandbox",
  ).toLowerCase();

  return rawMode === "production" || rawMode === "live"
    ? "production"
    : "sandbox";
}

function resolveBaseUrl() {
  const explicit = process.env.CASHFREE_BASE_URL;
  if (explicit) return explicit.replace(/\/+$/, "");
  return resolveMode() === "production"
    ? "https://api.cashfree.com"
    : "https://sandbox.cashfree.com";
}

function getCredentials() {
  const clientId =
    process.env.CASHFREE_CLIENT_ID || process.env.CASHFREE_APP_ID || "";
  const clientSecret =
    process.env.CASHFREE_CLIENT_SECRET || process.env.CASHFREE_SECRET_KEY || "";

  if (!clientId || !clientSecret) {
    throw providerError("Cashfree payments not configured");
  }

  return { clientId, clientSecret };
}

function buildClient() {
  const { clientId, clientSecret } = getCredentials();
  return axios.create({
    baseURL: `${resolveBaseUrl()}/pg`,
    timeout: 15000,
    headers: {
      "x-api-version": CASHFREE_API_VERSION,
      "x-client-id": clientId,
      "x-client-secret": clientSecret,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
  });
}

function formatAmountFromPaise(amount) {
  return Number((Number(amount || 0) / 100).toFixed(2));
}

function buildReturnUrl(orderId) {
  const explicit = process.env.CASHFREE_RETURN_URL;
  if (explicit) {
    return explicit.replace("{order_id}", encodeURIComponent(orderId));
  }

  const appUrl =
    process.env.FRONTEND_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.NEXT_PUBLIC_SITE_URL ||
    "";

  if (!appUrl) return undefined;
  const separator = appUrl.includes("?") ? "&" : "?";
  return `${appUrl.replace(/\/+$/, "")}/payment-status${separator}order_id=${encodeURIComponent(
    orderId,
  )}`;
}

function normalizeOrderResponse(data = {}, amountInPaise) {
  return {
    id: data.order_id,
    amount:
      Number.isFinite(Number(amountInPaise)) && Number(amountInPaise) > 0
        ? Number(amountInPaise)
        : Math.round(Number(data.order_amount || 0) * 100),
    currency: data.order_currency || "INR",
    payment_session_id: data.payment_session_id,
    order_status: data.order_status,
    cf_order_id: data.cf_order_id,
  };
}

async function createOrder(payload = {}) {
  const amount = Number(payload.amount || 0);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw providerError("Invalid order amount", "CASHFREE_INVALID_AMOUNT");
  }

  const notes = payload.notes || {};
  const orderId =
    payload.receipt ||
    `order_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;

  const customerId =
    String(notes.customerId || notes.studentId || notes.userId || "guest")
      .replace(/[^a-zA-Z0-9_\-]/g, "_")
      .slice(0, 45) || `customer_${Date.now()}`;

  const request = {
    order_id: orderId,
    order_amount: formatAmountFromPaise(amount),
    order_currency: payload.currency || "INR",
    customer_details: {
      customer_id: customerId,
      customer_name: String(notes.customerName || "Student").slice(0, 80),
      customer_email: notes.customerEmail || "support@tuitionstime.com",
      customer_phone: String(notes.customerPhone || "9999999999").slice(0, 15),
    },
    order_meta: {},
    order_note:
      typeof payload.notes === "string"
        ? payload.notes
        : JSON.stringify(notes).slice(0, 450),
  };

  const returnUrl = buildReturnUrl(orderId);
  if (returnUrl) {
    request.order_meta.return_url = returnUrl;
  }

  const response = await buildClient().post("/orders", request);
  return normalizeOrderResponse(response.data, amount);
}

async function fetchOrder(orderId) {
  const response = await buildClient().get(`/orders/${orderId}`);
  return response.data;
}

async function fetchOrderPayments(orderId) {
  const response = await buildClient().get(`/orders/${orderId}/payments`);
  return Array.isArray(response.data) ? response.data : [];
}

async function refund(paymentId, amountInPaise, meta = {}) {
  const response = await buildClient().post(`/orders/payments/${paymentId}/refunds`, {
    refund_amount: formatAmountFromPaise(amountInPaise),
    refund_id:
      meta.refundId ||
      `refund_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`,
    refund_note: meta.note || "Refund processed",
  });
  return response.data;
}

function verifyWebhookSignature(signature, rawBody, timestamp) {
  const { clientSecret } = getCredentials();
  if (!signature || !rawBody || !timestamp) return false;
  const payload = `${timestamp}${rawBody}`;
  const generated = crypto
    .createHmac("sha256", clientSecret)
    .update(payload)
    .digest("base64");
  return generated === signature;
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
  verifyWebhookSignature,
  resolveMode,
};
