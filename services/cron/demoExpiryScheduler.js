const nodeCron = require("node-cron");
const Booking = require("../../models/Booking");
const realtimeEvents = require("../realtimeEventService");
const notificationService = require("../notificationService");
const emailTpl = require("../../templates/emailTemplates");
const User = require("../../models/User");
const StudentProfile = require("../../models/StudentProfile");
const TutorProfile = require("../../models/TutorProfile");
const { determineDemoCompletion } = require("../demoCompletionService");

const DEMO_DURATION_MINUTES = Number(
  process.env.DEMO_DURATION_MINUTES || 15
);
const DEMO_EXPIRE_GRACE_MINUTES = Number(
  process.env.DEMO_EXPIRE_GRACE_MINUTES || 5
);
const DEMO_PENDING_ACCEPT_EXPIRY_HOURS = Number(
  process.env.DEMO_PENDING_ACCEPT_EXPIRY_HOURS ||
    process.env.DEMO_PENDING_TUTOR_ACCEPT_EXPIRY_HOURS ||
    24
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

function getPendingExpiryContext(booking, { studentName, tutorName, subject }) {
  const expiryHours = DEMO_PENDING_ACCEPT_EXPIRY_HOURS;

  if (booking.requestedBy === "tutor") {
    return {
      reason: "student-no-response",
      nonResponderName: studentName,
      requesterName: tutorName,
      studentEmailMessage:
        `The demo request from <strong>${tutorName}</strong> for ` +
        `<strong>${subject}</strong> expired because you did not accept it within ${expiryHours} hours. Please Book Again if you still want the demo.`,
      tutorEmailMessage:
        `Your demo request for <strong>${subject}</strong> expired because ` +
        `<strong>${studentName}</strong> did not accept it within ${expiryHours} hours. Please Book Again.`,
      studentInAppMessage:
        `The demo request from ${tutorName} expired because you did not accept it within ${expiryHours} hours. Please Book Again.`,
      tutorInAppMessage:
        `Your demo request with ${studentName} expired because it was not accepted within ${expiryHours} hours. Please Book Again.`,
      realtimeMessage: `The student did not accept the demo request within ${expiryHours} hours.`,
    };
  }

  return {
    reason: "tutor-no-response",
    nonResponderName: tutorName,
    requesterName: studentName,
    studentEmailMessage:
      `Your demo request for <strong>${subject}</strong> expired because ` +
      `<strong>${tutorName}</strong> did not accept it within ${expiryHours} hours. Please Book Again.`,
    tutorEmailMessage:
      `The demo request from <strong>${studentName}</strong> for ` +
      `<strong>${subject}</strong> expired because you did not accept it within ${expiryHours} hours.`,
    studentInAppMessage:
      `Your demo request with ${tutorName} expired because it was not accepted within ${expiryHours} hours. Please Book Again.`,
    tutorInAppMessage:
      `The demo request from ${studentName} expired because it was not accepted within ${expiryHours} hours.`,
    realtimeMessage: `The tutor did not accept the demo request within ${expiryHours} hours.`,
  };
}

async function notifyPendingAcceptanceExpired(booking) {
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
    const context = getPendingExpiryContext(booking, {
      studentName,
      tutorName,
      subject,
    });

    if (studentUser?.email && notificationService?.sendEmail) {
      await notificationService.sendEmail(
        studentUser.email,
        "Demo Request Expired - tuitionstime",
        "",
        emailTpl.bookingExpiredHTML({
          headline: "Demo Request Expired",
          message: context.studentEmailMessage,
          ctaLabel: "Book Again",
        })
      );
    }

    if (tutorUser?.email && notificationService?.sendEmail) {
      await notificationService.sendEmail(
        tutorUser.email,
        "Demo Request Expired - tuitionstime",
        "",
        emailTpl.bookingExpiredHTML({
          headline: "Demo Request Expired",
          message: context.tutorEmailMessage,
          ctaLabel: "Book Again",
        })
      );
    }

    if (notificationService?.createInApp) {
      await notificationService.createInApp(
        booking.studentId,
        "Demo Request Expired",
        context.studentInAppMessage,
        { bookingId: booking._id, reason: context.reason }
      );
      await notificationService.createInApp(
        booking.tutorId,
        "Demo Request Expired",
        context.tutorInAppMessage,
        { bookingId: booking._id, reason: context.reason }
      );
    }
  } catch (err) {
    console.warn("Pending demo expiry notification failed:", err.message);
  }
}

async function expirePendingRequests(now) {
  const threshold = new Date(
    now.getTime() - DEMO_PENDING_ACCEPT_EXPIRY_HOURS * 60 * 60 * 1000
  );

  const pendingBookings = await Booking.find({
    type: "demo",
    status: "pending",
    createdAt: { $lte: threshold },
    studentJoinedAt: null,
    tutorJoinedAt: null,
  });

  for (const booking of pendingBookings) {
    const context = getPendingExpiryContext(booking, {
      studentName: "Student",
      tutorName: "Tutor",
      subject: booking.subject || "the demo class",
    });

    booking.status = "expired";
    booking.expiryReason = context.reason;
    booking.expiredAt = now;
    await booking.save();

    await notifyPendingAcceptanceExpired(booking);

    realtimeEvents.notifyBookingStatusUpdate(booking, {
      title: "Demo request expired",
      message: context.realtimeMessage,
      body: "We have marked the demo request as expired for both student and tutor.",
    });
  }
}

async function runOnce() {
  const now = new Date();

  await expirePendingRequests(now);

  const threshold = new Date(
    now.getTime() -
      DEMO_EXPIRE_GRACE_MINUTES * 60 * 1000
  );

  const joinedCandidates = await Booking.find({
    type: "demo",
    status: "confirmed",
    $or: [
      { studentJoinedAt: { $ne: null } },
      { tutorJoinedAt: { $ne: null } },
    ],
  });

  for (const booking of joinedCandidates) {
    const endDate = getBookingEndDatetime(booking);
    if (!endDate) continue;
    if (endDate > threshold) continue;

    const { updated, status } = determineDemoCompletion(booking, now);
    if (!updated) continue;

    await booking.save();

    if (["completed", "student-missed", "tutor-missed"].includes(status)) {
      realtimeEvents.notifyBookingCompletion(booking);
    }
  }

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

