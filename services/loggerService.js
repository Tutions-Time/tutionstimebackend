const AuditLog = require("../models/AuditLog");

const logActivity = async (req, action, details = {}, status = 200) => {
  try {
    const logEntry = {
      user: (req.user && req.user.id) || (details && details.userId) || null,
      action: action,
      method: req.method,
      resource: req.originalUrl,
      ip:
        req.ip ||
        req.headers["x-forwarded-for"] ||
        req.connection.remoteAddress,
      userAgent: req.headers["user-agent"],
      details: details,
      status: status,
    };

    // Print to console (Terminal)
    const timestamp = new Date().toISOString();
    const userStr = logEntry.user ? `User:${logEntry.user}` : "Guest";
    const statusColor = status >= 400 ? "\x1b[31m" : "\x1b[32m"; // Red for error, Green for success
    const resetColor = "\x1b[0m";

    console.log(
      `[AUDIT] ${timestamp} | ${action} | ${req.method} ${req.originalUrl} | ${userStr} | ${statusColor}${status}${resetColor}`,
    );

    // Use setImmediate to not block the event loop
    setImmediate(async () => {
      try {
        await AuditLog.create(logEntry);
      } catch (err) {
        console.error("Failed to save audit log:", err);
      }
    });
  } catch (error) {
    console.error("Logger Service Error:", error);
  }
};

module.exports = {
  logActivity,
};
