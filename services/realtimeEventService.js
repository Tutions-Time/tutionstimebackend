const wsHub = require("./wsHub");
const StudentProfile = require("../models/StudentProfile");
const TutorProfile = require("../models/TutorProfile");

function buildBookingMeta(booking) {
  return {
    bookingId: booking?._id ? String(booking._id) : null,
    meetingId: booking?.meetingId || "",
    status: booking?.status || "",
    type: booking?.type || "",
    actualEndTime: booking?.actualEndTime || null,
  };
}

function buildSessionMeta(session) {
  if (!session) return {};
  return {
    sessionId: session._id ? String(session._id) : null,
    regularClassId: session.regularClassId
      ? String(session.regularClassId)
      : null,
    groupBatchId: session.groupBatchId ? String(session.groupBatchId) : null,
    meetingId: session.meetingId || "",
    status: session.status || "",
    actualEndTime: session.actualEndTime || null,
  };
}

function sendToUserIfAvailable(userId, payload) {
  if (!userId) return;
  wsHub.sendToUser(String(userId), payload);
}

function sendNotificationToTargets(payload, booking) {
  sendToUserIfAvailable(booking.studentId, payload);
  sendToUserIfAvailable(booking.tutorId, payload);
  wsHub.sendToRole("admin", {
    type: "admin_notification",
    data: {
      ...payload.data,
      meta: payload.data.meta,
    },
  });
}

function notifyBookingCompletion(booking) {
  if (!booking) return;
  notifyBookingStatusUpdate(booking, {
    title: "Demo class completed",
    message: "This demo booking has been marked as completed.",
    body: "The class has ended and attendance has been finalized.",
  });
}

function notifyBookingStatusUpdate(booking, { title, message, body }) {
  if (!booking) return;
  const meta = buildBookingMeta(booking);
  const notification = {
    title,
    message,
    body,
    meta,
  };
  const payload = { type: "notification", data: notification };
  console.log("notifyBookingStatusUpdate", {
    title,
    status: meta.status,
    meetingId: meta.meetingId,
  });
  sendNotificationToTargets(payload, booking);
}

async function resolveUserIdFromProfile(model, profileId) {
  if (!profileId) return null;
  const profile = await model.findById(profileId).select("userId").lean();
  if (!profile?.userId) return null;
  return String(profile.userId);
}

async function notifySessionCompletion(session) {
  if (!session) return;
  const meta = buildSessionMeta(session);
  const notification = {
    title: "Session completed",
    message: "This class session has ended.",
    body: "Attendance and completion status have been recorded.",
    meta,
  };
  const payload = { type: "notification", data: notification };

  const [studentUserId, tutorUserId] = await Promise.all([
    resolveUserIdFromProfile(StudentProfile, session.studentId),
    resolveUserIdFromProfile(TutorProfile, session.tutorId),
  ]);

  sendToUserIfAvailable(studentUserId, payload);
  sendToUserIfAvailable(tutorUserId, payload);

  wsHub.sendToRole("admin", {
    type: "admin_notification",
    data: {
      title: "Session completed",
      message: `Session ${meta.sessionId} has ended.`,
      body: `Meeting ID ${meta.meetingId} ended at ${meta.actualEndTime || "unknown"}.`,
      meta,
    },
  });
}

module.exports = {
  notifyBookingCompletion,
  notifyBookingStatusUpdate,
  notifySessionCompletion,
};
