const axios = require('axios');

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

// BulkSMS integration
const bulkSmsUsername = process.env.BULKSMS_USERNAME;
const bulkSmsPassword = process.env.BULKSMS_PASSWORD;
const bulkSmsFrom = process.env.BULKSMS_FROM;

const sendOTP = async (phone, otp) => {
  if (!bulkSmsUsername || !bulkSmsPassword) {
    // Development fallback if BulkSMS credentials are not set
    console.log("==================================");
    console.log("BulkSMS credentials missing, logging OTP instead.");
    console.log(`Phone: ${phone}`);
    console.log(`OTP: ${otp}`);
    console.log(`Time: ${new Date().toISOString()}`);
    console.log("==================================");
    return true;
  }

  const payload = {
    to: [phone],
    body: `Your OTP is ${otp}`
  };

  if (bulkSmsFrom) {
    const cleanedFrom = bulkSmsFrom.replace(/[^A-Za-z0-9]/g, '');
    if (cleanedFrom.length > 0 && cleanedFrom.length <= 11) {
      payload.from = cleanedFrom;
    } else {
      console.log('BulkSMS from value is invalid, sending without from.');
    }
  }

  try {
    await axios.post('https://api.bulksms.com/v1/messages', payload, {
      auth: {
        username: bulkSmsUsername,
        password: bulkSmsPassword
      },
      headers: {
        'Content-Type': 'application/json'
      }
    });
    return true;
  } catch (error) {
    console.log('BulkSMS send failed:', error.response?.data || error.message);
    return false;
  }
};

module.exports = {
  storeOTP,
  verifyOTP,
  sendOTP,
};
