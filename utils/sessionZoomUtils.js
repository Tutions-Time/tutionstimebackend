const DEFAULT_SESSION_DURATION_MINUTES = Number(
  process.env.DEFAULT_SESSION_DURATION_MINUTES || 60
);
const zoomService = require("../services/zoomService");

function computeDurationMinutes(startTime, endTime) {
  if (!startTime || !endTime) {
    return DEFAULT_SESSION_DURATION_MINUTES;
  }
  const [sh, sm] = startTime.split(":").map(Number);
  const [eh, em] = endTime.split(":").map(Number);
  if (
    !Number.isFinite(sh) ||
    !Number.isFinite(sm) ||
    !Number.isFinite(eh) ||
    !Number.isFinite(em)
  ) {
    return DEFAULT_SESSION_DURATION_MINUTES;
  }
  let diff = eh * 60 + em - (sh * 60 + sm);
  if (diff <= 0) {
    diff += 24 * 60;
  }
  return diff || DEFAULT_SESSION_DURATION_MINUTES;
}

function buildGroupSessionTopic(batch, dateTime) {
  const subject = batch?.subject || "Group Batch Session";
  const typeLabel =
    batch?.batchType === "revision"
      ? "Revision"
      : batch?.batchType === "normal class"
      ? "Class"
      : batch?.batchType || "Batch";
  const dateLabel = dateTime.toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  const timeLabel = dateTime.toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${subject} (${typeLabel}) - ${timeLabel} on ${dateLabel}`;
}

async function buildBatchSessionPayload(batch, sessionDate) {
  const duration = computeDurationMinutes(batch?.recurring?.time, batch?.recurring?.endTime);
  const topic = buildGroupSessionTopic(batch, sessionDate);
  const meeting = await zoomService.createZoomMeeting({
    topic,
    startTime: sessionDate.toISOString(),
    duration,
  });

  return {
    groupBatchId: batch._id,
    tutorId: batch.tutorId,
    startDateTime: sessionDate,
    meetingId: meeting.id ? String(meeting.id) : "",
    meetingPassword: meeting.password || meeting.encrypted_password || "",
    startUrl: meeting.start_url || "",
    joinUrl: meeting.join_url || "",
    meetingLink: meeting.join_url || "",
    status: "scheduled",
  };
}

module.exports = {
  computeDurationMinutes,
  buildGroupSessionTopic,
  DEFAULT_SESSION_DURATION_MINUTES,
  buildBatchSessionPayload,
};
