const mongoose = require("mongoose");

const auditLogSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    default: null,
  },
  action: {
    type: String,
    required: true,
    index: true,
  },
  method: {
    type: String,
    uppercase: true,
  },
  resource: {
    type: String,
  },
  details: {
    type: mongoose.Schema.Types.Mixed,
    default: {},
  },
  ip: {
    type: String,
  },
  userAgent: {
    type: String,
  },
  status: {
    type: Number,
  },
  createdAt: {
    type: Date,
    default: Date.now,
    expires: 60 * 60 * 24 * 30, // Optional: Auto-delete logs after 30 days
  },
});

module.exports = mongoose.model("AuditLog", auditLogSchema);
