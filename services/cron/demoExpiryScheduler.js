const nodeCron = require("node-cron");
const Booking = require("../../models/Booking");
const realtimeEvents = require("../realtimeEventService");
const notificationService = require("../notificationService");
const emailTpl = require("../../templates/emailTemplates");
const User = require("../../models/User");
const StudentProfile = require("../../models/StudentProfile");
const TutorProfile = require("../../models/TutorProfile");

const DEMO_DURATION_MINUTES = Number(
  process.env.DEMO_DURATION_MINUTES || 15
);
const DEMO_EXPIRE_GRACE_MINUTES = Number(
  process.env.DEMO_EXPIRE_GRACE_MINUTES || 5
);
const DEMO_PENDING_TUTOR_ACCEPT_EXPIRY_HOURS = Number(
  process.env.DEMO_PENDING_TUTOR_ACCEPT_EXPIRY_HOURS || 5
);

function parseTime(timeStr) {
  if (!timeStr) return null;
  const [hourStr, minuteStr] = timeStr.split(":");
  const hour = Number(hourStr);
  const minute = Number(minuteStr);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  return { hour, minute };
}

function getBookingEndDatetime(booking) {
  if (!booking?.preferredDate) return null;
  const base = new Date(booking.preferredDate);

  let target = parseTime(booking.preferredEndTime);
  if (!target) {
    target = parseTime(booking.preferredTime);
  }

  if (!target) return null;

  const endDate = new Date(
    base.getFullYear(),
    base.getMonth(),
    base.getDate(),
    target.hour,
    target.minute,
    0,
    0
  );

  if (!booking.preferredEndTime && booking.preferredTime) {
    endDate.setMinutes(endDate.getMinutes() + DEMO_DURATION_MINUTES);
  }

  return endDate;
}

async function notifyPendingTutorAcceptanceExpired(booking) {
  try {
    const [studentUser, tutorUser, studentProfile, tutorProfile] =
      await Promise.all([
        User.findById(booking.studentId).select("email").lean(),
        User.findById(booking.tutorId).select("email").lean(),
        StudentProfile.findOne({ userId: booking.studentId })
          .select("name")
          .lean(),
        TutorProfile.findOne({ userId: booking.tutorId })
          .select("name")
          .lean(),
      ]);

    const studentName = studentProfile?.name || "Student";
    const tutorName = tutorProfile?.name || "Tutor";
    const subject = booking.subject || "the demo class";
    const reasonText =
      `The demo request for <strong>${subject}</strong> expired because ` +
      `<strong>${tutorName}</strong> did not accept it within 5 hours.`;

    if (studentUser?.email && notificationService?.sendEmail) {
      await notificationService.sendEmail(
        studentUser.email,
        "Demo Request Expired - TuitionTime",
        "",
        emailTpl.bookingExpiredHTML({
          headline: "Demo Request Expired",
          message: reasonText,
        })
      );
    }

    if (tutorUser?.email && notificationService?.sendEmail) {
      await notificationService.sendEmail(
        tutorUser.email,
        "Demo Request Expired - TuitionTime",
        "",
        emailTpl.bookingExpiredHTML({
          headline: "Demo Request Expired",
          message:
            `The demo request from <strong>${studentName}</strong> for ` +
            `<strong>${subject}</strong> expired because it was not accepted within 5 hours.`,
        })
      );
    }

    if (notificationService?.createInApp) {
      await notificationService.createInApp(
        booking.studentId,
        "Demo Request Expired",
        `Your demo request with ${tutorName} expired because it was not accepted within 5 hours.`,
        { bookingId: booking._id, reason: "tutor-no-response" }
      );
      await notificationService.createInApp(
        booking.tutorId,
        "Demo Request Expired",
        `The demo request from ${studentName} expired because it was not accepted within 5 hours.`,
        { bookingId: booking._id, reason: "tutor-no-response" }
      );
    }
  } catch (err) {
    console.warn("Pending demo expiry notification failed:", err.message);
  }
}

async function expirePendingStudentRequests(now) {
  const threshold = new Date(
    now.getTime() - DEMO_PENDING_TUTOR_ACCEPT_EXPIRY_HOURS * 60 * 60 * 1000
  );

  const pendingBookings = await Booking.find({
    type: "demo",
    requestedBy: "student",
    status: "pending",
    createdAt: { $lte: threshold },
    studentJoinedAt: null,
    tutorJoinedAt: null,
  });

  for (const booking of pendingBookings) {
    booking.status = "expired";
    booking.expiryReason = "tutor-no-response";
    booking.expiredAt = now;
    await booking.save();

    await notifyPendingTutorAcceptanceExpired(booking);

    realtimeEvents.notifyBookingStatusUpdate(booking, {
      title: "Demo request expired",
      message: "The tutor did not accept the demo request within 5 hours.",
      body: "We have marked the demo request as expired for both student and tutor.",
    });
  }
}

async function runOnce() {
  const now = new Date();

  await expirePendingStudentRequests(now);

  const threshold = new Date(
    now.getTime() -
      DEMO_EXPIRE_GRACE_MINUTES * 60 * 1000
  );

  const candidates = await Booking.find({
    type: "demo",
    status: "confirmed",
    studentJoinedAt: null,
    tutorJoinedAt: null,
  });

  for (const booking of candidates) {
    const endDate = getBookingEndDatetime(booking);
    if (!endDate) continue;
    if (endDate > threshold) continue;

    booking.status = "expired";
    booking.expiryReason = "no-show";
    booking.expiredAt = now;
    booking.attendance = "absent";
    await booking.save();

    realtimeEvents.notifyBookingStatusUpdate(booking, {
      title: "Demo expired",
      message: "The scheduled demo was not joined by anyone.",
      body: "We have marked the demo as expired.",
    });
  }
}

function start() {
  nodeCron.schedule("*/5 * * * *", runOnce);
}

module.exports = {
  start,
  runOnce,
};
