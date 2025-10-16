// Using a more persistent object for development
let otpStore = {};

// Add persistence helper functions
const saveOTPStore = () => {
  console.log('Current OTP Store State:', otpStore);
};

const generateOTP = () => {
  // Generate a 6-digit OTP
  return Math.floor(100000 + Math.random() * 900000).toString();
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
    createdAt: Date.now()
  };
  
  console.log(`Storing OTP - RequestID: ${requestId}, Phone: ${phone}, OTP: ${otp}`);
  saveOTPStore();
  
  return { otp, requestId, expiresAt };
};

const verifyOTP = (requestId, providedOTP) => {
  console.log('Verifying OTP:', { requestId, providedOTP });
  console.log('Current OTP Store:', otpStore);
  
  const otpData = otpStore[requestId];
  
  if (!otpData) {
    console.log('OTP data not found for requestId:', requestId);
    // List all available requestIds
    console.log('Available requestIds:', Object.keys(otpStore));
    return { valid: false, message: 'Invalid or expired request ID' };
  }
  
  console.log('Found OTP data:', { 
    ...otpData,
    otp: '***',
    age: Math.round((Date.now() - otpData.createdAt) / 1000) + ' seconds'
  });
  
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
  console.log('OTP verified successfully for phone:', otpData.phone);
  delete otpStore[requestId];
  saveOTPStore();
  
  return { 
    valid: true, 
    phone: otpData.phone, 
    purpose: otpData.purpose 
  };
};

const sendOTP = async (phone, otp) => {
  // For development, just log the OTP
  console.log('==================================');
  console.log(`📱 New OTP Request`);
  console.log(`📞 Phone: ${phone}`);
  console.log(`🔐 OTP: ${otp}`);
  console.log(`⏰ Time: ${new Date().toISOString()}`);
  console.log('==================================');
  return true;
};

module.exports = {
  storeOTP,
  verifyOTP,
  sendOTP
};