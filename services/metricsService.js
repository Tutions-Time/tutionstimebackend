const winston = require("winston");

const logger = winston.createLogger({
  level: "info",
  transports: [new winston.transports.Console()],
});

function emit(name, tags = {}, fields = {}) {
  logger.info(`[metric] ${name}`, { tags, fields, ts: new Date().toISOString() });
}

exports.incrementFill = (batchId) => emit("group.fill", { batchId });
exports.incrementConversion = (batchId) => emit("group.conversion", { batchId });
exports.incrementAttendance = (batchId, sessionId) => emit("group.attendance", { batchId, sessionId });
exports.incrementRefund = (batchId) => emit("group.refund", { batchId });
exports.emit = emit;
