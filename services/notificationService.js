// services/notificationService.js
const Notification = require('../models/Notification');

// --- In-app notification ---
exports.createInApp = async (userId, title, body, meta = {}) => {
  try {
    await Notification.create({ userId, title, body, meta });
  } catch (e) {
    console.error('createInApp error:', e.message);
  }
};

// --- Email placeholder (plug later) ---
exports.sendEmail = async (to, subject, text) => {
  console.log('📧 Email =>', { to, subject, text });
};

// --- SMS placeholder ---
exports.sendSMS = async (to, text) => {
  console.log('📱 SMS =>', { to, text });
};
