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

// Run every day at 1 AM - Generate Sessions (weekly rolling window)
cron.schedule("0 1 * * *", async () => {
  console.log("Running batch session generation job...");
  try {
    const batches = await GroupBatch.find({ status: "active", scheduleType: "recurring" });
    
    for (const gb of batches) {
      if (!gb.recurring || !gb.recurring.days || !gb.recurring.time) continue;

      const now = new Date();
      const targetDays = new Set((gb.recurring.days || []).map(d => daysMap[d]).filter(d => d !== undefined));
      if (!targetDays.size) continue;

      // Gather upcoming sessions
      const upcoming = await Session.find({
        groupBatchId: gb._id,
        startDateTime: { $gte: now }
      }).select("startDateTime").sort({ startDateTime: 1 });

      // Helper to create sessions within a YMD range
      async function createInRange(ymdFrom, ymdTo) {
        const sessionDates = [];
        let cur = ymdFrom;
        const existingYmdSet = new Set(
          (await Session.find({
            groupBatchId: gb._id,
            startDateTime: { $gte: new Date(`${ymdFrom}T00:00:00Z`), $lte: new Date(`${ymdTo}T23:59:59Z`) }
          }).select("startDateTime")).map(s => toYmd(s.startDateTime)).filter(Boolean)
        );
        while (cur && cur <= ymdTo) {
          const dow = dayIndexFromYmd(cur);
          if (dow !== null && targetDays.has(dow) && !existingYmdSet.has(cur)) {
            const dt = buildRawDateTime(cur, String(gb.recurring.time));
            if (dt && dt.getTime() > now.getTime()) {
              // Respect batch end date
              const batchEndYmd = toYmd(gb.recurring.endDate);
              if (batchEndYmd && cur <= batchEndYmd) {
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

      const batchStartYmd = toYmd(gb.recurring.startDate);
      const todayYmd = toYmd(now);
      // Initial seeding: if no upcoming, seed next 7 days from batch start (or tomorrow if starting today)
      if (!upcoming.length) {
        if (!batchStartYmd) continue;
        let seedStart = batchStartYmd === todayYmd ? addOneDayYmd(batchStartYmd) : batchStartYmd;
        let seedEnd = seedStart;
        for (let i = 1; i < 7; i++) seedEnd = addOneDayYmd(seedEnd);
        await createInRange(seedStart, seedEnd);
        continue;
      }

      // Rolling generation: on the last day of the current window, create the next 7 days
      const maxUpcoming = upcoming[upcoming.length - 1]?.startDateTime ? new Date(upcoming[upcoming.length - 1].startDateTime) : null;
      if (!maxUpcoming) continue;
      const maxYmd = toYmd(maxUpcoming);
      // If the last scheduled day is today, roll another week
      if (maxYmd && maxYmd === todayYmd) {
        let nextStart = addOneDayYmd(maxYmd);
        let nextEnd = nextStart;
        for (let i = 1; i < 7; i++) nextEnd = addOneDayYmd(nextEnd);
        await createInRange(nextStart, nextEnd);
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
