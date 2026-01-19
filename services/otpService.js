const axios = require("axios");

// Using a more persistent object for development
let otpStore = {};

// Add persistence helper functions
const saveOTPStore = () => {
  // console.log("Current OTP Store State:", otpStore);
};

const generateOTP = () => {
  // Development default OTP
  // return Math.floor(100000 + Math.random() * 900000).toString();
  return "123456";
};

const normalizePhone = (phone) => {
  const trimmed = String(phone || "").trim();
  if (!trimmed) return trimmed;
  if (trimmed.startsWith("+")) return trimmed;
  return `+91${trimmed}`;
};

const normalizePhoneForMsg91 = (phone) => {
  const raw = String(phone || "").trim();
  if (!raw) return raw;
  const digits = raw.replace(/[^\d]/g, "");
  if (!digits) return "";
  if (digits.length === 10) return `91${digits}`;
  return digits;
};

const storeOTP = (phone, purpose) => {
  const otp = generateOTP();
  const requestId = Math.random().toString(36).substring(2, 15);
  const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes expiry

  otpStore[requestId] = {
    phone,
    otp,
    purpose,
    expiresAt,
    createdAt: Date.now(),
  };

  // console.log(
  //   `Storing OTP - RequestID: ${requestId}, Phone: ${phone}, OTP: ${otp}`
  // );
  saveOTPStore();

  return { otp, requestId, expiresAt };
};

const verifyOTP = (requestId, providedOTP, phone) => {
  // console.log('Verifying OTP:', { requestId, providedOTP, phone });
  // console.log('Current OTP Store:', otpStore);

  let otpData = otpStore[requestId];

  // Fallback: if requestId not found, try to locate by phone
  if (!otpData && phone) {
    const entry = Object.entries(otpStore).find(([rid, data]) => data.phone === phone);
    if (entry) {
      const [fallbackRequestId, data] = entry;
      console.log('Fallback to phone-based OTP entry:', { fallbackRequestId, phone });
      requestId = fallbackRequestId;
      otpData = data;
    }
  }

  if (!otpData) {
    console.log('OTP data not found for requestId:', requestId);
    console.log('Available requestIds:', Object.keys(otpStore));
    return { valid: false, message: 'Invalid or expired request ID' };
  }

  // console.log('Found OTP data:', {
  //   ...otpData,
  //   otp: '***',
  //   age: Math.round((Date.now() - otpData.createdAt) / 1000) + ' seconds'
  // });

  if (Date.now() > otpData.expiresAt) {
    console.log('OTP expired:', {
      expiresAt: new Date(otpData.expiresAt).toISOString(),
      now: new Date().toISOString(),
      age: Math.round((Date.now() - otpData.createdAt) / 1000) + ' seconds'
    });
    delete otpStore[requestId];
    saveOTPStore();
    return { valid: false, message: 'OTP expired. Please request a new one.' };
  }

  if (otpData.otp !== providedOTP) {
    console.log('OTP mismatch:', {
      provided: providedOTP,
      expected: otpData.otp,
      attempts: (otpData.attempts || 0) + 1
    });
    // Track failed attempts
    otpData.attempts = (otpData.attempts || 0) + 1;
    saveOTPStore();
    return { valid: false, message: 'Invalid OTP. Please check and try again.' };
  }

  // OTP is valid, delete it to prevent reuse
  // console.log('OTP verified successfully for phone:', otpData.phone);
  delete otpStore[requestId];
  saveOTPStore();

  return {
    valid: true,
    phone: otpData.phone,
    purpose: otpData.purpose
  };
};

// MSG91 OTP integration
const msg91AuthKey = process.env.MSG91_AUTH_KEY;
const msg91TemplateId = process.env.MSG91_OTP_TEMPLATE_ID;
const msg91ApiBase = process.env.MSG91_API_BASE || "https://control.msg91.com/api";

const sendOTP = async (phone, otp, requestId) => {
  const normalizedPhone = normalizePhoneForMsg91(phone);
  console.log("otp is sending via MSG91", {
    phone: normalizePhone(phone),
    normalizedPhone,
    time: new Date().toISOString(),
  });

  if (!msg91AuthKey || !msg91TemplateId) {
    console.log("==================================");
    console.log("MSG91 credentials missing. OTP SMS was not sent.", {
      hasAuthKey: !!msg91AuthKey,
      hasTemplateId: !!msg91TemplateId,
    });
    console.log(`Phone (normalized): ${normalizePhone(phone)}`);
    console.log(`Time: ${new Date().toISOString()}`);
    console.log("==================================");
    return true;
  }

  try {
    const response = await axios.get(`${msg91ApiBase}/v5/otp`, {
      params: {
        authkey: msg91AuthKey,
        template_id: msg91TemplateId,
        mobile: normalizedPhone,
        otp,
        otp_expiry: 5,
      },
    });

    const status = response?.status;
    const data = response?.data;
    const msg91ReqId = data?.request_id;

    console.log("MSG91 OTP send response", {
      status,
      type: data?.type,
      message: data?.message,
    });
    if (msg91ReqId) {
      console.log("MSG91 request_id", msg91ReqId);
    }
    if (requestId && otpStore[requestId]) {
      otpStore[requestId].msg91RequestId = msg91ReqId || null;
      saveOTPStore();
    }

    return status >= 200 && status < 300;
  } catch (error) {
    console.log("==================================");
    console.log("MSG91 OTP send failed");
    console.log(`Phone (raw): ${phone}`);
    console.log(`Phone (normalized for MSG91): ${normalizedPhone}`);
    console.log(`Template ID present:`, !!msg91TemplateId);
    console.log(
      "Error:",
      error?.response?.data || error.message || error
    );
    console.log(`Time: ${new Date().toISOString()}`);
    console.log("==================================");
    if (requestId && otpStore[requestId]) {
      otpStore[requestId].msg91Error =
        error?.response?.data || error.message || String(error);
      saveOTPStore();
    }
    return false;
  }
};

module.exports = {
  storeOTP,
  verifyOTP,
  sendOTP,
};
