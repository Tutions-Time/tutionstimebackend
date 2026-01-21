// const crypto = require("crypto");
// const Booking = require("../models/Booking");
// const Session = require("../models/Session");

// const ZOOM_WEBHOOK_SECRET = process.env.ZOOM_WEBHOOK_SECRET || "";

// function buildEncryptedToken(plainToken) {
//   return crypto
//     .createHmac("sha256", ZOOM_WEBHOOK_SECRET)
//     .update(plainToken)
//     .digest("hex");
// }

// function normalizeMeetingId(eventPayload) {
//   return (
//     String(eventPayload?.object?.id || eventPayload?.object?.meeting_id || "")
//   ).trim();
// }

// async function completeBooking(booking) {
//   if (!booking || booking.status === "completed") return;
//   booking.status = "completed";
//   booking.actualEndTime = new Date();
//   if (booking.studentJoinedAt) {
//     booking.attendance = "present";
//   } else if (booking.tutorJoinedAt) {
//     booking.attendance = "no-show";
//   } else {
//     booking.attendance = "absent";
//   }
//   await booking.save();
// }

// async function completeSession(session) {
//   if (!session || session.status === "completed") return;
//   session.status = "completed";
//   session.actualEndTime = new Date();
//   if (session.studentJoinTime) {
//     session.attendance = "present";
//   } else if (session.attendance !== "present") {
//     session.attendance = "absent";
//   }
//   await session.save();
// }

// exports.handleZoomWebhook = async (req, res) => {
//   try {
//     const eventBody = req.body || {};

//     if (eventBody?.event === "endpoint.url_validation") {
//       const plainToken = eventBody.payload?.plainToken;
//       if (!plainToken) {
//         return res
//           .status(400)
//           .json({ success: false, message: "Missing plainToken" });
//       }

//       const encryptedToken = buildEncryptedToken(plainToken);
//       return res.status(200).json({ plainToken, encryptedToken });
//     }

//     const meetingId = normalizeMeetingId(eventBody.payload || {});

//     if (eventBody.event === "meeting.ended" && meetingId) {
//       const booking = await Booking.findOne({ meetingId });
//       if (booking && booking.type === "demo") {
//         await completeBooking(booking);
//       } else {
//         const session = await Session.findOne({ meetingId });
//         await completeSession(session);
//       }
//     }

//     console.log("Zoom webhook event:", eventBody.event || "unknown");

//     return res.sendStatus(200);
//   } catch (err) {
//     console.error("zoom webhook error:", err);
//     return res.status(500).json({ success: false, message: "Server error" });
//   }
// };



const crypto = require("crypto");
const Booking = require("../models/Booking");
const Session = require("../models/Session");
const realtimeEvents = require("../services/realtimeEventService");
const { determineDemoCompletion } = require("../services/demoCompletionService");

const ZOOM_WEBHOOK_SECRET = process.env.ZOOM_WEBHOOK_SECRET || "";

function buildEncryptedToken(plainToken) {
  return crypto
    .createHmac("sha256", ZOOM_WEBHOOK_SECRET)
    .update(String(plainToken))
    .digest("hex");
}

// Zoom events usually have payload.object.id
// Some variants may have payload.id / payload.meeting_id, so we handle both.
function normalizeMeetingId(payload) {
  const obj = payload?.object || payload || {};
  return String(obj?.id || obj?.meeting_id || "").trim();
}

function getZoomEndTime(eventBody) {
  const endTimeStr = eventBody?.payload?.object?.end_time;
  const dt = endTimeStr ? new Date(endTimeStr) : null;
  return dt && !Number.isNaN(dt.getTime()) ? dt : new Date();
}

async function completeBooking(booking, endTime) {
  if (!booking) return null;

  const { updated, status } = determineDemoCompletion(booking, endTime);
  if (!updated) return null;

  await booking.save();

  if (["completed", "student-missed", "tutor-missed"].includes(status)) {
    realtimeEvents.notifyBookingCompletion(booking);
  }

  return status;
}

async function completeSession(session, endTime, options = {}) {
  if (!session || session.status === "completed") return false;

  session.status = "completed";
  session.actualEndTime = endTime || new Date();

  if (session.studentJoinTime) {
    session.attendance = "present";
  } else if (session.attendance !== "present") {
    session.attendance = "absent";
  }

  await session.save();
  if (options.notify) {
    await realtimeEvents.notifySessionCompletion(session);
  }

  return true;
}

exports.handleZoomWebhook = async (req, res) => {
  console.log("Received Zoom webhook");
  // Always ACK quickly to avoid Zoom retries/timeouts
  // We'll do DB processing asynchronously below.
  try {
    const eventBody = req.body || {};

    // 1) URL validation handshake
    if (eventBody?.event === "endpoint.url_validation") {
      const plainToken = eventBody?.payload?.plainToken;

      if (!plainToken) {
        return res
          .status(400)
          .json({ success: false, message: "Missing plainToken" });
      }

      if (!ZOOM_WEBHOOK_SECRET) {
        return res.status(500).json({
          success: false,
          message: "ZOOM_WEBHOOK_SECRET is not set in envv",
        });
      }

      const encryptedToken = buildEncryptedToken(plainToken);
      return res.status(200).json({ plainToken, encryptedToken });
    }

    // For real events: respond 200 ASAP
    res.sendStatus(200);

    // 2) Process event in background
    setImmediate(async () => {
      try {
        const event = eventBody?.event || "unknown";

        // Only handle meeting.ended for now (you can add more later)
        if (event === "meeting.ended") {
          const meetingId = normalizeMeetingId(eventBody?.payload);
          if (!meetingId) {
            console.warn("Zoom webhook: missing meetingId for meeting.ended");
            return;
          }

          const zoomEndTime = getZoomEndTime(eventBody);

          // First try booking
          const booking = await Booking.findOne({ meetingId });
          if (booking && booking.type === "demo") {
            const status = await completeBooking(booking, zoomEndTime);
            if (status) {
              console.log(`Zoom webhook: booking ${status}`, { meetingId });
            }
            return;
          }

          // Else try session
          const session = await Session.findOne({ meetingId });
          if (session) {
            const completed = await completeSession(session, zoomEndTime, {
              notify: true,
            });
            if (completed) {
              console.log("Zoom webhook: session completed", { meetingId });
            }
            return;
          }

          console.warn("Zoom webhook: no booking/session found", { meetingId });
          return;
        }

        // Log other events (optional)
        console.log("Zoom webhook event received:", event);
      } catch (bgErr) {
        console.error("Zoom webhook background processing error:", bgErr);
      }
    });
  } catch (err) {
    console.error("zoom webhook error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};
