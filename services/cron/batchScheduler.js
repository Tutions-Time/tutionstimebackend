const cron = require("node-cron");
const GroupBatch = require("../../models/GroupBatch");
const Session = require("../../models/Session");
const notificationService = require("../notificationService");
const { createBatchSessionsThrottled } = require("../../utils/sessionZoomUtils");

const daysMap = { "Sun": 0, "Mon": 1, "Tue": 2, "Wed": 3, "Thu": 4, "Fri": 5, "Sat": 6 };

function pad2(n) {
  return String(n).padStart(2, "0");
}
function toYmd(d) {
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return null;
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}
function addOneDayYmd(ymd) {
  const [y, m, d] = String(ymd).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (Number.isNaN(dt.getTime())) return null;
  dt.setUTCDate(dt.getUTCDate() + 1);
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}
function dayIndexFromYmd(ymd) {
  const [y, m, d] = String(ymd).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (Number.isNaN(dt.getTime())) return null;
  return dt.getUTCDay();
}
function buildRawDateTime(ymd, hhmm) {
  if (!ymd || !hhmm) return null;
  const m = String(hhmm).match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Math.max(0, Math.min(23, Number(m[1])));
  const min = Math.max(0, Math.min(59, Number(m[2])));
  const t = `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
  const dt = new Date(`${ymd}T${t}:00Z`);
  if (Number.isNaN(dt.getTime())) return null;
  return dt;
}

// Run every day at 1 AM - Generate Sessions
cron.schedule("0 1 * * *", async () => {
  console.log("Running batch session generation job...");
  try {
    const batches = await GroupBatch.find({ status: "active", scheduleType: "recurring" });
    
    for (const gb of batches) {
      if (!gb.recurring || !gb.recurring.days || !gb.recurring.time) continue;

      const targetDays = new Set((gb.recurring.days || []).map(d => daysMap[d]).filter(d => d !== undefined));
      if (!targetDays.size) continue;

      const now = new Date();
      const horizon = new Date(now);
      horizon.setDate(horizon.getDate() + 30);

      const startBound = new Date(Math.max(
        now.getTime(),
        gb.recurring.startDate ? new Date(gb.recurring.startDate).getTime() : now.getTime()
      ));
      const endBound = new Date(Math.min(
        horizon.getTime(),
        gb.recurring.endDate ? new Date(gb.recurring.endDate).getTime() : horizon.getTime()
      ));
      if (endBound.getTime() < startBound.getTime()) continue;

      const ymdStart = toYmd(startBound);
      const ymdEnd = toYmd(endBound);
      if (!ymdStart || !ymdEnd) continue;

      const existingSessions = await Session.find({
        groupBatchId: gb._id,
        startDateTime: { $gte: startBound, $lte: endBound }
      }).select("startDateTime");
      const existingYmdSet = new Set(
        existingSessions
          .map(s => toYmd(s.startDateTime))
          .filter(Boolean)
      );

      const sessionDates = [];
      let cur = ymdStart;
      while (cur && cur <= ymdEnd) {
        const dow = dayIndexFromYmd(cur);
        if (dow !== null && targetDays.has(dow)) {
          if (!existingYmdSet.has(cur)) {
            const dt = buildRawDateTime(cur, String(gb.recurring.time));
            if (dt && dt.getTime() > now.getTime()) {
              sessionDates.push(dt);
            }
          }
        }
        cur = addOneDayYmd(cur);
      }

      if (sessionDates.length > 0) {
        const created = await createBatchSessionsThrottled(gb, sessionDates, { batchSize: 2, delayMs: 1000 });
        console.log(`Generated ${created.length} sessions for batch ${gb._id}`);
      }
    }
  } catch (err) {
    console.error("Batch session generation error:", err);
  }
});

// Run every day at 9 AM - Expiration Notifications
cron.schedule("0 9 * * *", async () => {
    console.log("Running batch expiration notification job...");
    try {
        const batches = await GroupBatch.find({ status: "active", "enrollmentDetails.0": { $exists: true } })
            .populate("enrollmentDetails.studentId", "userId");
        
        for (const gb of batches) {
            for (const enrollment of gb.enrollmentDetails) {
                if (!enrollment.validUntil || !enrollment.studentId || !enrollment.studentId.userId) continue;
                
                const validUntil = new Date(enrollment.validUntil);
                const now = new Date();
                const diffTime = validUntil - now;
                const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)); 
                
                const userId = enrollment.studentId.userId;

                if (diffDays === 3) {
                     await notificationService.notifyUser(
                        userId,
                        "Subscription Expiring Soon",
                        `Your subscription for batch ${gb.subject} expires in 3 days. Renew now to continue learning.`,
                        { batchId: gb._id, type: "expiry_warning" }
                     );
                } else if (diffDays <= 0 && diffDays > -2) { // Expired today/yesterday
                     await notificationService.notifyUser(
                        userId,
                        "Subscription Expired",
                        `Your subscription for batch ${gb.subject} has expired. Please renew to access classes.`,
                        { batchId: gb._id, type: "expired" }
                     );
                }
            }
        }
    } catch (err) {
        console.error("Batch expiration notification error:", err);
    }
});

module.exports = {};
