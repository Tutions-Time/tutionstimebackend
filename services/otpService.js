const notificationService = require("./notificationService");
const OtpRequest = require("../models/OtpRequest");
const emailTemplates = require("../templates/emailTemplates");
const { nanoid } = require("nanoid");

const generateOTP = () => {
  const code = Math.floor(100000 + Math.random() * 900000);
  return String(code);
};

const normalizeEmail = (email) => {
  return String(email || "").trim().toLowerCase();
};

const storeOTP = async (email, purpose) => {
  const normalizedEmail = normalizeEmail(email);
  const now = Date.now();
  const expiresAt = new Date(now + 5 * 60 * 1000);
  const RESEND_THROTTLE_MS = 30 * 1000;

  const existing = await OtpRequest.findOne({ email: normalizedEmail, purpose })
    .sort({ createdAt: -1 });

  if (existing && new Date(existing.expiresAt).getTime() > now) {
    const updatedAtMs = existing.updatedAt ? new Date(existing.updatedAt).getTime() : 0;
    if (updatedAtMs && now - updatedAtMs < RESEND_THROTTLE_MS) {
      return { otp: existing.otp, requestId: existing.requestId, expiresAt: existing.expiresAt };
    }

    const otp = generateOTP();
    existing.otp = otp;
    existing.expiresAt = expiresAt;
    existing.attempts = 0;
    await existing.save();
    await OtpRequest.deleteMany({ email: normalizedEmail, purpose, _id: { $ne: existing._id } });
    return { otp, requestId: existing.requestId, expiresAt };
  }

  const otp = generateOTP();
  const requestId = nanoid(20);

  try {
    await OtpRequest.deleteMany({ email: normalizedEmail, purpose });
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
  const otpData = await OtpRequest.findOne({ requestId, email: normalizedEmail });

  if (!otpData) {
    return { valid: false, message: "Invalid or expired request ID" };
  }

  const MAX_ATTEMPTS = 5;
  if (Number(otpData.attempts || 0) >= MAX_ATTEMPTS) {
    await OtpRequest.deleteOne({ requestId });
    return { valid: false, message: "Too many attempts. Please request a new OTP." };
  }

  if (Date.now() > new Date(otpData.expiresAt).getTime()) {
    await OtpRequest.deleteOne({ requestId });
    return { valid: false, message: "OTP expired. Please request a new one." };
  }

  if (otpData.otp !== providedOTP) {
    await OtpRequest.updateOne({ requestId }, { $inc: { attempts: 1 } });
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

  const subject = "Your tuitionstime OTP";
  const text = `Your OTP code is ${otp}. Please enter it within 5 minutes to continue.`;
  const html = emailTemplates.otpEmailHTML({ otp });

  try {
    await notificationService.sendEmail(normalizedEmail, subject, text, html);
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
