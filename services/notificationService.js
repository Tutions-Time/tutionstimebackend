require("dotenv").config();
const nodemailer = require("nodemailer");
const axios = require("axios");
const Notification = require("../models/Notification");
const DeviceToken = require("../models/DeviceToken");
const User = require("../models/User");
const StudentProfile = require("../models/StudentProfile");
const TutorProfile = require("../models/TutorProfile");
const wsHub = require("./wsHub");

exports.createInApp = async (userId, title, body, meta = {}) => {
  try {
    const notif = await Notification.create({ userId, title, body, meta });
    wsHub.sendToUser(userId, { type: "notification", data: notif });
  } catch (e) {
    console.error("createInApp error:", e.message);
  }
};

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "smtp.gmail.com",
  port: Number(process.env.SMTP_PORT) || 465,
  secure: true,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

exports.sendEmail = async (to, subject, text, html = null) => {
  if (!transporter) return console.error("No transporter configured");
  if (!to) return console.warn("Missing recipient email");

  try {
    const mailOptions = {
      from: process.env.FROM_EMAIL || "TuitionTime <no-reply@tuitiontime.com>",
      to,
      subject,
      text,
      html: html || `<p>${text.replace(/\n/g, "<br/>")}</p>`,
    };

    const info = await transporter.sendMail(mailOptions);
    return info;
  } catch (err) {
    console.error("Email send failed:", err.message);
  }
};

exports.sendSMS = async (to, text) => {
  console.log("SMS =>", { to, text });
};

async function resolveEmailForUser(userId) {
  try {
    const user = await User.findById(userId).lean();
    if (user?.role === "student") {
      const sp = await StudentProfile.findOne({ userId }).select("email").lean();
      return sp?.email || null;
    }
    if (user?.role === "tutor") {
      const tp = await TutorProfile.findOne({ userId }).select("email").lean();
      return tp?.email || null;
    }
    return null;
  } catch (_) {
    return null;
  }
}

async function sendPushToUser(userId, title, body, meta = {}) {
  try {
    const tokens = await DeviceToken.find({ userId, enabled: true }).lean();
    if (!tokens.length) return;

    const serverKey = process.env.FCM_SERVER_KEY;
    if (!serverKey) return;
    const registrationIds = tokens.map((t) => String(t.token));
    const payload = {
      registration_ids: registrationIds,
      notification: { title, body },
      data: meta || {},
    };
    await axios.post("https://fcm.googleapis.com/fcm/send", payload, {
      headers: { Authorization: `key=${serverKey}` },
    });
  } catch (e) {
    console.error("push send error:", e.message);
  }
}

exports.notifyUser = async (userId, title, body, meta = {}) => {
  try {
    const user = await User.findById(userId).select("notificationPrefs role").lean();
    const prefs = user?.notificationPrefs || { email: true, push: true, inapp: true };
    if (prefs.inapp) {
      const notif = await Notification.create({ userId, title, body, meta });
      wsHub.sendToUser(userId, { type: "notification", data: notif });
    }
    if (prefs.email) {
      const email = await resolveEmailForUser(userId);
      if (email) {
        await exports.sendEmail(email, title, body);
      }
    }
    if (prefs.push) {
      await sendPushToUser(userId, title, body, meta);
    }
  } catch (e) {
    console.error("notifyUser error:", e.message);
  }
};
