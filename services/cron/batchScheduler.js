const cron = require("node-cron");
const GroupBatch = require("../../models/GroupBatch");
const Session = require("../../models/Session");
const notificationService = require("../notificationService");
const { createBatchSessionsThrottled } = require("../../utils/sessionZoomUtils");

const daysMap = { "Sun": 0, "Mon": 1, "Tue": 2, "Wed": 3, "Thu": 4, "Fri": 5, "Sat": 6 };

// Run every day at 1 AM - Generate Sessions
cron.schedule("0 1 * * *", async () => {
  console.log("Running batch session generation job...");
  try {
    const batches = await GroupBatch.find({ status: "active", scheduleType: "recurring" });
    
    for (const gb of batches) {
      if (!gb.recurring || !gb.recurring.days || !gb.recurring.time) continue;
      
      const targetDays = gb.recurring.days.map(d => daysMap[d]);
      const [startHour, startMinute] = gb.recurring.time.split(":").map(Number);
      
      const now = new Date();
      const endLimit = new Date();
      endLimit.setDate(endLimit.getDate() + 30);
      
      // Get existing sessions in range
      const existingSessions = await Session.find({
        groupBatchId: gb._id,
        startDateTime: { $gte: now, $lte: endLimit }
      }).select("startDateTime");
      
      const existingDates = new Set(existingSessions.map(s => new Date(s.startDateTime).toDateString()));
      
      const sessionDates = [];
      let current = new Date();
      
      while (current <= endLimit) {
        if (targetDays.includes(current.getDay())) {
          if (!existingDates.has(current.toDateString())) {
             const sessionDate = new Date(current);
             sessionDate.setHours(startHour, startMinute, 0, 0);
            if (sessionDate > Date.now()) {
                sessionDates.push(sessionDate);
             }
          }
        }
        current.setDate(current.getDate() + 1);
      }
      
      if (sessionDates.length > 0) {
        const created = await createBatchSessionsThrottled(gb, sessionDates, { batchSize: 10, delayMs: 1000 });
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
