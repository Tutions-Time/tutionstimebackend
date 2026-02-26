const DEFAULT_SESSION_DURATION_MINUTES = Number(
  process.env.DEFAULT_SESSION_DURATION_MINUTES || 60
);
const zoomService = require("../services/zoomService");

async function wait(ms) {
  if (ms > 0) {
    await new Promise((r) => setTimeout(r, ms));
  }
}

async function createMeetingWithRetry({ topic, startTime, duration }, opts = {}) {
  const retries = Math.max(0, Number(opts.retries ?? 3));
  const retryDelayMs = Math.max(0, Number(opts.retryDelayMs ?? 1500));
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await zoomService.createZoomMeeting({ topic, startTime, duration });
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        await wait(retryDelayMs);
      }
    }
  }
  throw lastErr || new Error("Zoom meeting creation failed");
}

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
    timeZone: "UTC",
  });
  const timeLabel = dateTime.toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });
  return `${subject} (${typeLabel}) - ${timeLabel} on ${dateLabel}`;
}

async function buildBatchSessionPayload(batch, sessionDate) {
  const duration = computeDurationMinutes(batch?.recurring?.time, batch?.recurring?.endTime);
  const topic = buildGroupSessionTopic(batch, sessionDate);
  const meeting = await createMeetingWithRetry({
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

async function createBatchSessionsThrottled(batch, sessionDates, options = {}) {
  const batchSize = Math.max(1, Math.min(50, Number(options.batchSize) || 2));
  const delayMs = Math.max(0, Number(options.delayMs) || 1000);
  const retries = Math.max(0, Number(options.retryCount ?? 3));
  const retryDelayMs = Math.max(0, Number(options.retryDelayMs ?? 1500));
  const now = Date.now();
  const dates = (sessionDates || [])
    .map((d) => new Date(d))
    .filter((d) => !Number.isNaN(d.getTime()) && d.getTime() > now);

  const created = [];
  for (let i = 0; i < dates.length; i += batchSize) {
    const chunk = dates.slice(i, i + batchSize);
    console.log("Creating zoom meetings", {
      batchId: String(batch?._id || ""),
      chunkStartIndex: i,
      chunkSize: chunk.length,
      total: dates.length,
      batchSize,
      delayMs,
    });
    const payloads = (await Promise.all(
      chunk.map(async (date) => {
        try {
          // inline retry with the same defaults used in buildBatchSessionPayload
          const duration = computeDurationMinutes(batch?.recurring?.time, batch?.recurring?.endTime);
          const topic = buildGroupSessionTopic(batch, date);
          const meeting = await createMeetingWithRetry(
            { topic, startTime: date.toISOString(), duration },
            { retries, retryDelayMs }
          );
          return {
            groupBatchId: batch._id,
            tutorId: batch.tutorId,
            startDateTime: date,
            meetingId: meeting.id ? String(meeting.id) : "",
            meetingPassword: meeting.password || meeting.encrypted_password || "",
            startUrl: meeting.start_url || "",
            joinUrl: meeting.join_url || "",
            meetingLink: meeting.join_url || "",
            status: "scheduled",
          };
        } catch (err) {
          const status = err?.response?.status || null;
          const data = err?.response?.data || null;
          console.error("Zoom meeting creation failed", {
            batchId: String(batch?._id || ""),
            startDateTime: date.toISOString(),
            status,
            data,
            message: err?.message || String(err),
          });
          return {
            groupBatchId: batch._id,
            tutorId: batch.tutorId,
            startDateTime: date,
            meetingId: "",
            meetingPassword: "",
            startUrl: "",
            joinUrl: "",
            meetingLink: "",
            status: "scheduled",
          };
        }
      })
    )).filter(Boolean);
    if (payloads.length) {
      const inserted = await require("../models/Session").insertMany(payloads);
      created.push(...inserted);
    }
    if (i + batchSize < dates.length && delayMs > 0) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  return created;
}

module.exports = {
  computeDurationMinutes,
  buildGroupSessionTopic,
  DEFAULT_SESSION_DURATION_MINUTES,
  buildBatchSessionPayload,
  createBatchSessionsThrottled,
};
