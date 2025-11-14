const AdminNotification = require("../models/AdminNotification");
const notificationService = require("../services/notificationService");

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || null;

async function createAdminNotification(title, message, meta = {}) {
  try {
    await AdminNotification.create({ title, message, meta });

    if (ADMIN_EMAIL && notificationService?.sendEmail) {
      const html = `
        <h2>${title}</h2>
        <p>${message}</p>
        <pre>${JSON.stringify(meta, null, 2)}</pre>
      `;
      await notificationService.sendEmail(ADMIN_EMAIL, title, html);
    }
  } catch (err) {
    console.error("Error creating admin notification:", err);
  }
}

module.exports = { createAdminNotification };
