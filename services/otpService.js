const notificationService = require("./notificationService");
const OtpRequest = require("../models/OtpRequest");

const generateOTP = () => {
  const code = Math.floor(100000 + Math.random() * 900000);
  return String(code);
};

const normalizeEmail = (email) => {
  return String(email || "").trim().toLowerCase();
};

const storeOTP = async (email, purpose) => {
  const normalizedEmail = normalizeEmail(email);
  const otp = generateOTP();
  const requestId = Math.random().toString(36).substring(2, 15);
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes expiry

  try {
    await OtpRequest.create({
      requestId,
      email: normalizedEmail,
      otp,
      purpose,
      expiresAt,
    });
  } catch (error) {
    console.error("OTP store creation failed:", error?.message || error);
    throw error;
  }

  return { otp, requestId, expiresAt };
};

const verifyOTP = async (requestId, providedOTP, email) => {
  const normalizedEmail = normalizeEmail(email);
  let otpData = await OtpRequest.findOne({ requestId });

  if (!otpData && normalizedEmail) {
    otpData = await OtpRequest.findOne({ email: normalizedEmail })
      .sort({ createdAt: -1 })
      .lean();

    if (otpData) {
      requestId = otpData.requestId;
      console.log("Fallback to email-based OTP entry:", {
        fallbackRequestId: requestId,
        email: normalizedEmail,
      });
    }
  }

  if (!otpData) {
    console.log("OTP data not found for requestId:", requestId);
    return { valid: false, message: "Invalid or expired request ID" };
  }

  if (Date.now() > new Date(otpData.expiresAt).getTime()) {
    console.log("OTP expired:", {
      expiresAt: otpData.expiresAt.toISOString(),
      now: new Date().toISOString(),
    });
    await OtpRequest.deleteOne({ requestId });
    return { valid: false, message: "OTP expired. Please request a new one." };
  }

  if (otpData.otp !== providedOTP) {
    await OtpRequest.updateOne(
      { requestId },
      { $inc: { attempts: 1 } }
    );
    console.log("OTP mismatch:", {
      provided: providedOTP,
      expected: otpData.otp,
    });
    return { valid: false, message: "Invalid OTP. Please check and try again." };
  }

  await OtpRequest.deleteOne({ requestId });

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
