const twilio = require('twilio');

const requiredEnv = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_VERIFY_SERVICE_SID'];
const hasTwilioConfig = requiredEnv.every((k) => process.env[k]);

let client;
if (hasTwilioConfig) {
  client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

const sendOtp = async (to) => {
  if (!hasTwilioConfig) throw new Error('Twilio env not configured');
  return client.verify.v2
    .services(process.env.TWILIO_VERIFY_SERVICE_SID)
    .verifications.create({ to, channel: 'sms' });
};

const verifyOtp = async (to, code) => {
  if (!hasTwilioConfig) throw new Error('Twilio env not configured');
  return client.verify.v2
    .services(process.env.TWILIO_VERIFY_SERVICE_SID)
    .verificationChecks.create({ to, code });
};

module.exports = { sendOtp, verifyOtp };