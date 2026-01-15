const AdminNotification = require("../models/AdminNotification");
const notificationService = require("./notificationService");
const wsHub = require("./wsHub");

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || null;

async function createAdminNotification(title, message, meta = {}) {
  try {
    if (process.env.NODE_ENV === "test") return;
    const notif = await AdminNotification.create({ title, message, meta });
    wsHub.sendToRole("admin", { type: "admin_notification", data: notif });

    if (ADMIN_EMAIL && notificationService?.sendEmail) {
      const html = `
        <h2>${title}</h2>
        <p>${message}</p>
        <pre>${JSON.stringify(meta, null, 2)}</pre>
      `;
      await notificationService.sendEmail(ADMIN_EMAIL, title, html);
    }
  } catch (err) {
    if (process.env.NODE_ENV !== "test") {
      console.error("Error creating admin notification:", err);
    }
  }
}

module.exports = { createAdminNotification };
