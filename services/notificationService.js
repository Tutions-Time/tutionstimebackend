require('dotenv').config();
const nodemailer = require('nodemailer');
const Notification = require('../models/Notification');

// --- In-App Notification (optional) ---
exports.createInApp = async (userId, title, body, meta = {}) => {
  try {
    await Notification.create({ userId, title, body, meta });
  } catch (e) {
    console.error('❌ createInApp error:', e.message);
  }
};

// --- Gmail-only Transporter ---
console.log('📨 Using Gmail SMTP for emails');
    // console.log('✅ .env loaded, SMTP_USER =', process.env.SMTP_USER);

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: Number(process.env.SMTP_PORT) || 465,
  secure: true,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// --- Send Email Function ---
exports.sendEmail = async (to, subject, text, html = null) => {
  if (!transporter) return console.error('❌ No transporter configured');
  if (!to) return console.warn('⚠️ Missing recipient email');

  console.log('📧 Preparing to send email:', { to, subject });

  try {
    const mailOptions = {
      from: process.env.FROM_EMAIL || 'TuitionTime <no-reply@tuitiontime.com>',
      to,
      subject,
      text,
      html: html || `<p>${text.replace(/\n/g, '<br/>')}</p>`,
    };

    const info = await transporter.sendMail(mailOptions);
    console.log(`✅ Email sent successfully to ${to}: ${info.messageId}`);
    return info;
  } catch (err) {
    console.error('❌ Email send failed:', err.message);
  }
};

// --- SMS Placeholder (optional) ---
exports.sendSMS = async (to, text) => {
  console.log('📱 SMS =>', { to, text });
};
