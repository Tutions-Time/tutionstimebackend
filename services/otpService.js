const notificationService = require("./notificationService");

// Using a more persistent object for development
let otpStore = {};

// Add persistence helper functions
const saveOTPStore = () => {
  // console.log("Current OTP Store State:", otpStore);
};

const generateOTP = () => {
  const code = Math.floor(100000 + Math.random() * 900000);
  return String(code);
};

const normalizeEmail = (email) => {
  return String(email || "").trim().toLowerCase();
};

const storeOTP = (email, purpose) => {
  const normalizedEmail = normalizeEmail(email);
  const otp = generateOTP();
  const requestId = Math.random().toString(36).substring(2, 15);
  const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes expiry

  otpStore[requestId] = {
    email: normalizedEmail,
    otp,
    purpose,
    expiresAt,
    createdAt: Date.now(),
  };

  saveOTPStore();

  return { otp, requestId, expiresAt };
};

const verifyOTP = (requestId, providedOTP, email) => {
  const normalizedEmail = normalizeEmail(email);

  let otpData = otpStore[requestId];

  if (!otpData && normalizedEmail) {
    const entry = Object.entries(otpStore).find(
      ([rid, data]) => data.email === normalizedEmail
    );
    if (entry) {
      const [fallbackRequestId, data] = entry;
      console.log("Fallback to email-based OTP entry:", {
        fallbackRequestId,
        email: normalizedEmail,
      });
      requestId = fallbackRequestId;
      otpData = data;
    }
  }

  if (!otpData) {
    console.log("OTP data not found for requestId:", requestId);
    console.log("Available requestIds:", Object.keys(otpStore));
    return { valid: false, message: "Invalid or expired request ID" };
  }

  if (Date.now() > otpData.expiresAt) {
    console.log("OTP expired:", {
      expiresAt: new Date(otpData.expiresAt).toISOString(),
      now: new Date().toISOString(),
      age:
        Math.round((Date.now() - otpData.createdAt) / 1000) + " seconds",
    });
    delete otpStore[requestId];
    saveOTPStore();
    return { valid: false, message: "OTP expired. Please request a new one." };
  }

  if (otpData.otp !== providedOTP) {
    console.log("OTP mismatch:", {
      provided: providedOTP,
      expected: otpData.otp,
      attempts: (otpData.attempts || 0) + 1,
    });
    otpData.attempts = (otpData.attempts || 0) + 1;
    saveOTPStore();
    return { valid: false, message: "Invalid OTP. Please check and try again." };
  }

  delete otpStore[requestId];
  saveOTPStore();

  return {
    valid: true,
    email: otpData.email,
    purpose: otpData.purpose,
  };
};

const sendOTP = async (email, otp) => {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return false;

  const subject = "Your Tuitionstime OTP";
  const text = `Your OTP code is ${otp}. Please enter it within 5 minutes to continue.`;

  try {
    await notificationService.sendEmail(normalizedEmail, subject, text);
    console.log("Email OTP sent:", { email: normalizedEmail, time: new Date().toISOString() });
    return true;
  } catch (error) {
    console.error("Email OTP send failed:", error?.message || error);
    return false;
  }
};

module.exports = {
  storeOTP,
  verifyOTP,
  sendOTP,
};
