const axios = require("axios");
const crypto = require("crypto");

const CASHFREE_PAYOUT_API_VERSION =
  process.env.CASHFREE_PAYOUT_API_VERSION || "2024-01-01";

function resolveMode() {
  const rawMode = String(
    process.env.CASHFREE_PAYOUT_ENV ||
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
  const explicit = process.env.CASHFREE_PAYOUT_BASE_URL;
  if (explicit) return explicit.replace(/\/+$/, "");
  return resolveMode() === "production"
    ? "https://api.cashfree.com"
    : "https://sandbox.cashfree.com";
}

function getCredentials() {
  const clientId =
    process.env.CASHFREE_PAYOUT_CLIENT_ID ||
    process.env.CASHFREE_CLIENT_ID ||
    process.env.CASHFREE_APP_ID ||
    "";
  const clientSecret =
    process.env.CASHFREE_PAYOUT_CLIENT_SECRET ||
    process.env.CASHFREE_CLIENT_SECRET ||
    process.env.CASHFREE_SECRET_KEY ||
    "";

  if (!clientId || !clientSecret) {
    const err = new Error("Cashfree payouts not configured");
    err.code = "CASHFREE_PAYOUT_NOT_CONFIGURED";
    throw err;
  }

  return { clientId, clientSecret };
}

function client() {
  const { clientId, clientSecret } = getCredentials();
  return axios.create({
    baseURL: resolveBaseUrl(),
    timeout: 15000,
    headers: {
      "x-api-version": CASHFREE_PAYOUT_API_VERSION,
      "x-client-id": clientId,
      "x-client-secret": clientSecret,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
  });
}

function buildBeneficiaryId(tutor) {
  return `tutor_${String(tutor._id || tutor.userId || Date.now())
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(-32)}`;
}

async function ensureContactAndFundAccount(tutor) {
  const api = client();
  const beneficiaryId =
    tutor.cashfreeBeneficiaryId || tutor.razorpayxFundAccountId || buildBeneficiaryId(tutor);
  const useUPI = !!(tutor.upiId && tutor.upiId.trim());

  const payload = {
    beneficiary_id: beneficiaryId,
    beneficiary_name: tutor.name || tutor.accountHolderName || "Tutor",
    beneficiary_instrument_details: useUPI
      ? {
          instrument_type: "upi",
          upi_id: tutor.upiId.trim(),
        }
      : {
          instrument_type: "bank_account",
          bank_account_number: tutor.bankAccountNumber,
          bank_ifsc: tutor.ifsc,
          bank_account_holder_name:
            tutor.accountHolderName || tutor.name || "Tutor",
        },
  };

  try {
    await api.post("/payout/beneficiary", payload);
  } catch (error) {
    const status = error?.response?.status;
    if (status !== 409) throw error;
  }

  return { contactId: beneficiaryId, fundAccountId: beneficiaryId, useUPI };
}

async function createPayout(fundAccountId, amountInRupees, mode, referenceId) {
  const api = client();
  const transferId =
    referenceId || `transfer_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
  const useUPI = String(mode || "").toUpperCase() === "UPI";

  const payload = {
    transfer_id: transferId,
    transfer_amount: Number(Number(amountInRupees || 0).toFixed(2)),
    transfer_currency: "INR",
    beneficiary_details: {
      beneficiary_id: fundAccountId,
    },
    transfer_mode: useUPI ? "upi" : "banktransfer",
    remarks: "Tutor payout",
  };

  const response = await api.post("/payout/transfers", payload);
  return response.data;
}

function verifyWebhookSignature(signature, rawBody, timestamp) {
  const { clientSecret } = getCredentials();
  if (!signature || !rawBody || !timestamp) return false;
  const generated = crypto
    .createHmac("sha256", clientSecret)
    .update(`${timestamp}${rawBody}`)
    .digest("base64");
  return generated === signature;
}

module.exports = {
  ensureContactAndFundAccount,
  createPayout,
  verifyWebhookSignature,
};
