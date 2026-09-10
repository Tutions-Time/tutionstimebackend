const nodeCron = require("node-cron");
const Session = require("../../models/Session");
const realtimeEvents = require("../realtimeEventService");

const REGULAR_SESSION_DURATION_MINUTES = Number(
  process.env.REGULAR_SESSION_DURATION_MINUTES || 60
);
const SESSION_COMPLETE_GRACE_MINUTES = Number(
  process.env.SESSION_COMPLETE_GRACE_MINUTES || 5
);

function minutesAfter(date, minutes) {
  return new Date(new Date(date).getTime() + Number(minutes || 0) * 60 * 1000);
}

function getScheduledCompletionAt(session) {
  const start = new Date(session.startDateTime);
  if (Number.isNaN(start.getTime())) return null;
  return minutesAfter(
    start,
    REGULAR_SESSION_DURATION_MINUTES + SESSION_COMPLETE_GRACE_MINUTES
  );
}

function bothLeft(session) {
  return Boolean(session.studentLeaveTime && session.tutorLeaveTime);
}

function shouldCompleteSession(session, now) {
  if (!session || session.status !== "scheduled") return false;
  if (bothLeft(session)) return true;

  const scheduledCompletionAt = getScheduledCompletionAt(session);
  if (!scheduledCompletionAt) return false;
  return now >= scheduledCompletionAt;
}

function finalizeAttendance(session) {
  const studentPresent = Boolean(session.studentJoinTime);
  const tutorPresent = Boolean(session.tutorJoinTime);

  session.studentAttendance = studentPresent ? "present" : "absent";
  session.tutorAttendance = tutorPresent ? "present" : "absent";

  // Existing reports treat attendance as the completed student class attendance.
  // It is present only when both sides actually joined the class.
  session.attendance = studentPresent && tutorPresent ? "present" : "absent";
}

async function completeSession(session, now) {
  session.status = "completed";
  session.actualEndTime = bothLeft(session)
    ? new Date(Math.max(
        new Date(session.studentLeaveTime).getTime(),
        new Date(session.tutorLeaveTime).getTime()
      ))
    : now;
  finalizeAttendance(session);
  await session.save();

  try {
    await realtimeEvents.notifySessionCompletion(session);
  } catch (err) {
    console.warn("Session completion notification failed:", err.message);
  }
}

async function runOnce() {
  const now = new Date();
  const sessions = await Session.find({ status: "scheduled" }).limit(500);

  for (const session of sessions) {
    if (!shouldCompleteSession(session, now)) continue;
    await completeSession(session, now);
  }
}

function start() {
  nodeCron.schedule("*/1 * * * *", runOnce);
}

module.exports = {
  start,
  runOnce,
};
