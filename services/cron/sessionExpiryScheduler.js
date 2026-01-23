const nodeCron = require("node-cron");
const Session = require("../../models/Session");
const realtimeEvents = require("../realtimeEventService");

// How long after start time to consider a session "expired" if not started?
// Assuming max class duration is ~1-2 hours, let's say 3 hours to be safe.
const SESSION_EXPIRY_MINUTES = 180; // 3 hours

async function runOnce() {
  try {
    const now = new Date();
    // Find sessions that started more than 3 hours ago but are still "scheduled"
    const threshold = new Date(now.getTime() - SESSION_EXPIRY_MINUTES * 60 * 1000);

    const staleSessions = await Session.find({
      status: "scheduled",
      startDateTime: { $lte: threshold },
    });

    if (staleSessions.length > 0) {
      console.log(`Found ${staleSessions.length} stale sessions. Marking as expired.`);
    }

    for (const session of staleSessions) {
      session.status = "expired";
      session.attendance = "absent"; // No one showed up (or at least tracking didn't happen)
      session.actualEndTime = now; // Mark end time as expiry time
      await session.save();

      // Notify relevant parties
      await realtimeEvents.notifySessionCompletion(session); 
      // Note: notifySessionCompletion sends "Session completed" message. 
      // We might want a specific "Session expired" notification in future, 
      // but for now, ensuring the state is updated is key.
    }
  } catch (err) {
    console.error("Session expiry scheduler error:", err);
  }
}

function start() {
  // Run every 30 minutes
  nodeCron.schedule("*/30 * * * *", runOnce);
}

module.exports = {
  start,
  runOnce,
};
