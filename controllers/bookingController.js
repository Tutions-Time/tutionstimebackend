const Booking = require('../models/Booking');
const TutorProfile = require('../models/TutorProfile');
const StudentProfile = require('../models/StudentProfile');
const RegularClass = require("../models/RegularClass");
const Session = require("../models/Session");
const Payment = require("../models/Payment");
const User = require('../models/User');
const mongoose = require("mongoose");
const notificationService = require('../services/notificationService');
const emailTpl = require('../templates/emailTemplates');
const AdminNotification = require('../models/AdminNotification');
const wsHub = require('../services/wsHub');
const zoomService = require('../services/zoomService');
const { determineDemoCompletion } = require('../services/demoCompletionService');
const realtimeEvents = require('../services/realtimeEventService');

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || null;

// Demo duration in minutes (business rule)
const DEMO_DURATION_MINUTES = 15;
const DEMO_JOIN_BEFORE_MINUTES = 10;
const DEMO_EXPIRE_AFTER_MINUTES = 5;
const REGULAR_SESSION_DURATION_MINUTES = Number(
  process.env.REGULAR_SESSION_DURATION_MINUTES || 60
);
// Booking timezone offset (minutes), default IST
const BOOKING_TZ_OFFSET_MIN = Number(process.env.BOOKING_TZ_OFFSET_MIN || 330);

function toStartOfDay(dateStr) {
  const d = new Date(dateStr);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function isValidDateInput(dateStr) {
  if (!dateStr) return false;
  const d = new Date(dateStr);
  return !Number.isNaN(d.getTime());
}

function isValidTimeInput(timeStr) {
  return parseTime24ToMinutes(timeStr) !== null;
}

function resolveObjectIdString(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    return String(value.id || value._id || value.userId || "");
  }
  return String(value);
}

function addMinutesToTime(timeStr, minutesToAdd) {
  // timeStr in "HH:MM" 24-hr format
  const [hourStr, minuteStr] = timeStr.split(":");
  let totalMinutes = parseInt(hourStr, 10) * 60 + parseInt(minuteStr, 10);
  totalMinutes += minutesToAdd;

  const newHour = Math.floor(totalMinutes / 60) % 24;
  const newMinute = totalMinutes % 60;

  return `${String(newHour).padStart(2, "0")}:${String(newMinute).padStart(
    2,
    "0"
  )}`;
}

function minutesAfter(date, minutes) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function getBookingStartDateTime(booking) {
  if (!booking?.preferredDate || !booking?.preferredTime) return null;
  const baseUtc = new Date(booking.preferredDate);
  const [hourStr, minuteStr] = String(booking.preferredTime).split(":");
  const hour = Number(hourStr);
  const minute = Number(minuteStr);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;

  const shifted = new Date(baseUtc.getTime() + BOOKING_TZ_OFFSET_MIN * 60000);
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth();
  const day = shifted.getUTCDate();
  const utcMs =
    Date.UTC(year, month, day, hour, minute, 0, 0) -
    BOOKING_TZ_OFFSET_MIN * 60000;

  return new Date(utcMs);
}

function getBookingEndDateTime(booking) {
  if (!booking?.preferredDate) return null;
  const targetTime = booking.preferredEndTime || null;
  if (targetTime) {
    const [hourStr, minuteStr] = String(targetTime).split(":");
    const hour = Number(hourStr);
    const minute = Number(minuteStr);
    if (Number.isFinite(hour) && Number.isFinite(minute)) {
      const baseUtc = new Date(booking.preferredDate);
      const shifted = new Date(baseUtc.getTime() + BOOKING_TZ_OFFSET_MIN * 60000);
      const year = shifted.getUTCFullYear();
      const month = shifted.getUTCMonth();
      const day = shifted.getUTCDate();
      const utcMs =
        Date.UTC(year, month, day, hour, minute, 0, 0) -
        BOOKING_TZ_OFFSET_MIN * 60000;
      return new Date(utcMs);
    }
  }
  const start = getBookingStartDateTime(booking);
  if (!start) return null;
  return minutesAfter(start, DEMO_DURATION_MINUTES);
}

function isDemoJoinWindowOpen(booking) {
  const start = getBookingStartDateTime(booking);
  const end = getBookingEndDateTime(booking);
  if (!start || !end) return false;
  const now = Date.now();
  const openAt = start.getTime() - DEMO_JOIN_BEFORE_MINUTES * 60 * 1000;
  const closeAt = end.getTime() + DEMO_EXPIRE_AFTER_MINUTES * 60 * 1000;
  return now >= openAt && now <= closeAt;
}

function buildDemoTopic(booking) {
  const subject = booking?.subject || "tuitionstime Demo";
  if (booking?.preferredDate) {
    const dateLabel = new Date(booking.preferredDate).toLocaleDateString("en-IN");
    return `${subject} (${dateLabel})`;
  }
  return subject;
}

async function ensureDemoZoomMeeting(booking) {
  const startDateTime = getBookingStartDateTime(booking);
  if (!startDateTime) {
    throw new Error("Unable to calculate demo start time for Zoom meeting.");
  }

  const topic = buildDemoTopic(booking);
  const meeting = await zoomService.createZoomMeeting({
    topic,
    startTime: startDateTime.toISOString(),
    duration: DEMO_DURATION_MINUTES,
  });

  booking.meetingId = meeting.id ? String(meeting.id) : booking.meetingId || "";
  booking.meetingPassword =
    meeting.password || meeting.encrypted_password || booking.meetingPassword || "";
  booking.startUrl = meeting.start_url || booking.startUrl || "";
  booking.joinUrl = meeting.join_url || booking.joinUrl || "";
  booking.meetingLink = booking.joinUrl || booking.meetingLink || "";
}

function normalizeArray(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val.filter(Boolean);
  if (typeof val === "string") {
    try {
      const parsed = JSON.parse(val);
      if (Array.isArray(parsed)) return parsed.filter(Boolean);
    } catch {}
    return val
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

function parseTime24ToMinutes(timeStr) {
  const m = String(timeStr || "").trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min) || h < 0 || h > 23 || min < 0 || min > 59) {
    return null;
  }
  return h * 60 + min;
}

function parseTime12ToMinutes(timeStr) {
  const m = String(timeStr || "")
    .trim()
    .match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  const period = String(m[3]).toUpperCase();
  if (!Number.isFinite(h) || !Number.isFinite(min) || h < 1 || h > 12 || min < 0 || min > 59) {
    return null;
  }
  h = h % 12;
  if (period === "PM") h += 12;
  return h * 60 + min;
}

function isTimeWithinPreferredSlots(time24, preferredTimes) {
  const target = parseTime24ToMinutes(time24);
  if (target === null) return false;
  const slots = Array.isArray(preferredTimes) ? preferredTimes : [];
  if (!slots.length) return true;
  let parsedSlotCount = 0;

  for (const slot of slots) {
    const parts = String(slot || "")
      .split("-")
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length !== 2) continue;
    const startMin = parseTime12ToMinutes(parts[0]);
    const endMin = parseTime12ToMinutes(parts[1]);
    if (startMin === null || endMin === null) continue;
    parsedSlotCount += 1;

    // Normal slot (e.g. 10:00 AM - 01:00 PM)
    if (endMin >= startMin) {
      if (target >= startMin && target <= endMin) return true;
      continue;
    }
    // Overnight slot (e.g. 11:00 PM - 01:00 AM)
    if (target >= startMin || target <= endMin) return true;
  }

  // If legacy/invalid slot strings exist but none are parseable, don't hard block.
  if (parsedSlotCount === 0) return true;
  return false;
}

async function createAdminNotification(title, message, meta = {}) {
  try {
    const notif = await AdminNotification.create({ title, message, meta });
    wsHub.sendToRole("admin", { type: "admin_notification", data: notif });

    if (ADMIN_EMAIL && notificationService?.sendEmail) {
      const html = `
        <h2>${title}</h2>
        <p>${message}</p>
        <pre style="font-size:12px;background:#f4f4f5;padding:8px;border-radius:6px;">
${JSON.stringify(meta, null, 2)}
        </pre>
      `;
      await notificationService.sendEmail(
        ADMIN_EMAIL,
        `[Admin] ${title}`,
        message,
        html
      );
    }
  } catch (err) {
    console.warn("AdminNotification create failed:", err.message);
  }
}

/**
 * Student-initiated demo booking
 * POST /api/bookings/demo
 * Body: { tutorId, subject, date, time, note? }
 */
exports.createDemoBooking = async (req, res) => {
  try {
    const {
      tutorId,
      subject,
      subjects,
      date,
      time,
      note,
      studentBoard,
    } = req.body;
    console.log("createDemoBooking req.body:", req.body);

    const selectedSubjects = normalizeArray(subjects || subject);
    const subjectForDisplay = selectedSubjects[0] || subject;

    if (!tutorId || !selectedSubjects.length || !date || !time) {
      return res.status(400).json({
        success: false,
        message: "tutorId, subjects, date, time are required",
      });
    }

    // Block if the student already has a pending/confirmed demo whose scheduled
    // end time is still in the future (i.e. the time window hasn't passed yet).
    const now = new Date();
    const activeDemos = await Booking.find({
      studentId: req.user.id,
      type: "demo",
      status: { $in: ["pending", "confirmed"] },
    }).lean();

    const hasActiveUpcomingDemo = activeDemos.some((demo) => {
      const endDt = getBookingEndDateTime(demo);
      return endDt && endDt > now;
    });

    if (hasActiveUpcomingDemo) {
      return res.status(400).json({
        success: false,
        message:
          "You already have a demo session scheduled. Please wait until it is completed before booking another.",
      });
    }

    // Block booking with suspended tutors
    const tutorUser = await User.findById(tutorId).select("status").lean();
    if (!tutorUser) {
      return res
        .status(404)
        .json({ success: false, message: "Tutor not found" });
    }
    if (String(tutorUser.status || "").toLowerCase() === "suspended") {
      return res
        .status(403)
        .json({ success: false, message: "Tutor unavailable" });
    }

    const tutorProfile = await TutorProfile.findOne({ userId: tutorId }).lean();
    if (!tutorProfile) {
      return res
        .status(404)
        .json({ success: false, message: "Tutor not found" });
    }

    const preferredDate = toStartOfDay(date);
    const today = new Date();
    const todayStart = new Date(
      today.getFullYear(),
      today.getMonth(),
      today.getDate()
    );
    if (preferredDate < todayStart) {
      return res.status(400).json({
        success: false,
        message: "Please select a date from today onwards",
      });
    }

    // Prevent double booking for same student/tutor/slot
    const existingForSameStudent = await Booking.findOne({
      studentId: req.user.id,
      tutorId,
      type: "demo",
      preferredDate,
      preferredTime: time,
      status: { $ne: "cancelled" },
    });

    if (existingForSameStudent) {
      return res.status(400).json({
        success: false,
        message:
          "You already booked a demo with this tutor for this time slot.",
      });
    }

    // Prevent another student from taking same slot
    const existingSlotForTutor = await Booking.findOne({
      tutorId,
      type: "demo",
      preferredDate,
      preferredTime: time,
      status: { $in: ["pending", "confirmed"] },
    });

    if (
      existingSlotForTutor &&
      existingSlotForTutor.studentId.toString() !== req.user.id
    ) {
      return res.status(400).json({
        success: false,
        message: "This time slot is already booked for this tutor.",
      });
    }

    // Demo duration is 15 minutes
    const preferredEndTime = addMinutesToTime(time, DEMO_DURATION_MINUTES);

    const studentProfile = await StudentProfile.findOne({
      userId: req.user.id,
    }).lean();
    const resolvedStudentBoard = studentProfile?.board || studentBoard || "";
    const booking = await Booking.create({
      studentId: req.user.id,
      tutorId,
      subject: subjectForDisplay,
      subjects: selectedSubjects,
      studentBoard: resolvedStudentBoard,
      studentLearningMode: "Online",
      preferredDate,
      preferredTime: time,
      preferredEndTime, // 15 min demo end time
      note: note || "",
      type: "demo",
      status: "pending",
      meetingLink: "",
      requestedBy: "student",
    });

    await notifyTutorAboutStudentDemoRequest({
      booking,
      tutorProfile,
      studentProfile,
      tutorId,
      studentId: req.user.id,
      subject: subjectForDisplay,
      date,
      time,
      selectedSubjects,
    });

    return res.status(201).json({ success: true, data: booking });
  } catch (err) {
    console.error("createDemoBooking error:", err);
    return res.status(500).json({
      success: false,
      message: "Failed to create demo booking",
    });
  }
};

/**
 * ✅ Tutor-initiated Demo Booking
 * POST /api/bookings/tutor/demo
 * Body: { studentId, subject, date, time, note }
 * - studentId = User._id of the student
 * - tutorId = req.user.id (logged in tutor)
 */
exports.createDemoBookingByTutor = async (req, res) => {
  try {
    const tutorId = req.user.id; // logged-in tutor
    const { studentId: rawStudentId, subject, date, time, note } = req.body;
    console.log("createDemoBookingByTutor req.body:", req.body);

    const studentId = resolveObjectIdString(rawStudentId);

    if (!studentId || !subject || !date || !time) {
      return res.status(400).json({
        success: false,
        message: "studentId, subject, date, time are required",
      });
    }

    if (!mongoose.Types.ObjectId.isValid(studentId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid studentId",
      });
    }

    if (!isValidDateInput(date)) {
      return res.status(400).json({
        success: false,
        message: "Invalid date",
      });
    }

    if (!isValidTimeInput(time)) {
      return res.status(400).json({
        success: false,
        message: "Invalid time. Use HH:mm format",
      });
    }

    const preferredDate = toStartOfDay(date);
    const today = new Date();
    const todayStart = new Date(
      today.getFullYear(),
      today.getMonth(),
      today.getDate()
    );
    if (preferredDate < todayStart) {
      return res.status(400).json({
        success: false,
        message: "Please select a date from today onwards",
      });
    }

    const existingActiveDemo = await Booking.findOne({
      studentId,
      type: "demo",
      status: { $in: ["pending", "confirmed"] },
    });

    if (existingActiveDemo) {
      return res.status(400).json({
        success: false,
        message:
          "Student already has an active demo. Complete it before booking another.",
      });
    }

    const existingDemoForTutor = await Booking.findOne({
      studentId,
      tutorId,
      type: "demo",
      status: { $in: ["pending", "confirmed"] },
    });

    if (existingDemoForTutor) {
      return res.status(400).json({
        success: false,
        message: "Only one demo per student-tutor pair is allowed.",
      });
    }

    // Tutor profile (who is sending request)
    const tutorProfile = await TutorProfile.findOne({ userId: tutorId }).lean();
    if (!tutorProfile) {
      return res
        .status(404)
        .json({ success: false, message: "Tutor profile not found" });
    }
    if (!tutorProfile.isVerified) {
      return res.status(403).json({
        success: false,
        message:
          "Your tutor profile is not verified yet. You can send demo requests after admin verification.",
      });
    }

    // Student profile (who receives request)
    const studentProfile = await StudentProfile.findOne({
      userId: studentId,
    }).lean();
    if (!studentProfile) {
      return res
        .status(404)
        .json({ success: false, message: "Student profile not found" });
    }

    const subjectSlot = Array.isArray(studentProfile.subjectTimeSlots)
      ? studentProfile.subjectTimeSlots.find(
          (item) =>
            String(item?.subject || "").trim().toLowerCase() ===
            String(subject || "").trim().toLowerCase()
        )
      : null;
    const studentPreferredTimes = subjectSlot
      ? normalizeArray(subjectSlot.slots)
      : normalizeArray(studentProfile.preferredTimes);
    if (
      studentPreferredTimes.length > 0 &&
      !isTimeWithinPreferredSlots(time, studentPreferredTimes)
    ) {
      return res.status(400).json({
        success: false,
        message: "Please choose a time within student's preferred time slots",
        preferredTimes: studentPreferredTimes,
      });
    }

    // ✅ Check tutor availability (same logic as student->tutor flow)
    // Prevent double booking for same tutor+student+slot
    const existingForSamePair = await Booking.findOne({
      studentId,
      tutorId,
      type: "demo",
      preferredDate,
      preferredTime: time,
      status: { $ne: "cancelled" },
    });

    if (existingForSamePair) {
      return res.status(400).json({
        success: false,
        message:
          "You already have a demo request with this student for this time slot.",
      });
    }

    // Prevent double booking of the slot for this tutor
    const existingSlotForTutor = await Booking.findOne({
      tutorId,
      type: "demo",
      preferredDate,
      preferredTime: time,
      status: { $in: ["pending", "confirmed"] },
    });

    if (existingSlotForTutor) {
      return res.status(400).json({
        success: false,
        message: "This time slot is already booked for you.",
      });
    }

    // Demo duration is 15 minutes
    const preferredEndTime = addMinutesToTime(time, DEMO_DURATION_MINUTES);

    // ✅ Create booking – IMPORTANT mapping
    const booking = await Booking.create({
      studentId, // receiver
      tutorId, // sender
      subject,
      studentLearningMode: "Online",
      preferredDate,
      preferredTime: time,
      preferredEndTime, // 15 min demo end time
      note: note || "",
      type: "demo",
      status: "pending",
      meetingLink: "",
      requestedBy: "tutor", // NEW
    });

    void notifyTutorDemoBooking({
      booking,
      tutorProfile,
      studentProfile,
      tutorId,
      studentId,
      subject,
      date,
      time,
    });

    // Notify Admin
    void createAdminNotification(
      "Tutor-initiated Demo Requested",
      `Tutor ${tutorProfile?.name || tutorId} initiated a demo with student ${studentProfile?.name || studentId} for ${subject} on ${date}`,
      {
        bookingId: booking._id,
        studentId,
        tutorId,
        subject,
        date,
        time,
      }
    );

    return res.status(201).json({ success: true, data: booking });
  } catch (err) {
    console.error("createDemoBookingByTutor error:", err);
    if (err?.code === 11000) {
      return res.status(400).json({
        success: false,
        message:
          "A demo booking already exists for this student, tutor, date, and time.",
      });
    }
    if (err?.name === "CastError" || err?.name === "ValidationError") {
      return res.status(400).json({
        success: false,
        message: err.message,
      });
    }
    return res.status(500).json({
      success: false,
      message: "Failed to create demo booking by tutor",
    });
  }
};

async function notifyTutorAboutStudentDemoRequest({
  booking,
  tutorProfile,
  studentProfile,
  tutorId,
  subject,
  date,
  time,
  selectedSubjects,
  studentId,
}) {
  try {
    const student = studentProfile;
    const tutorUser = await User.findById(tutorId).select("email phone").lean();

    const tutorEmail = tutorProfile?.email || tutorUser?.email;
    const studentName = student?.name || "A student";
    const tutorName = tutorProfile?.name || "Tutor";
    const title = "New Demo Request";
    const body = `${studentName} requested a demo for ${subject} on ${date} at ${time}`;
    const meta = {
      type: "demo_request",
      requestedBy: "student",
      bookingId: booking._id,
      tutorId,
      studentId,
      subject,
      subjects: selectedSubjects,
      date,
      time,
      status: booking.status,
    };

    if (notificationService?.createInApp) {
      await notificationService.createInApp(tutorId, title, body, meta);
    }

    if (tutorEmail && notificationService?.sendEmail) {
      const html =
        emailTpl.tutorDemoRequestHTML?.({
          studentName,
          subject,
          date,
          time,
        }) ||
        `<p>${studentName} requested a demo for ${subject} on ${date} at ${time}.</p><p>Please log in to your tuitionstime dashboard to confirm or cancel this request.</p>`;

      await notificationService.sendEmail(
        tutorEmail,
        "New Demo Request - tuitionstime",
        body,
        html
      );
    }

    await createAdminNotification(
      "New Demo Booking Created",
      `${studentName} requested a demo with ${tutorName} for ${subject} on ${date} at ${time}`,
      meta
    );
  } catch (e) {
    console.warn("Student demo request tutor notification failed:", e.message);
  }
}

async function notifyTutorDemoBooking({
  booking,
  tutorProfile,
  studentProfile,
  tutorId,
  studentId,
  subject,
  date,
  time,
}) {
  try {
    const studentUser = await User.findById(studentId).lean();
    const tutorUser = await User.findById(tutorId).lean();

    const tutorName = tutorProfile.name || tutorUser?.phone || "A tutor";
    const studentEmail = studentProfile.email || studentUser?.email;

    if (studentEmail && notificationService?.sendEmail) {
      const html =
        emailTpl.studentDemoRequestHTML?.({
          tutorName,
          subject,
          date,
          time,
        }) ||
        `<p>${tutorName} has requested a demo for ${subject} on ${date} at ${time}.</p>`;

      await notificationService.sendEmail(
        studentEmail,
        "New Demo Request from Tutor - tuitionstime",
        "",
        html
      );
    }

    if (notificationService?.createInApp) {
      await notificationService.createInApp(
        studentId,
        "New Demo Request",
        `${tutorName} requested a demo for ${subject} on ${date} at ${time}`,
        { tutorId, studentId, subject, date, time, bookingId: booking._id }
      );
    }

    await createAdminNotification(
      "New Tutor-Initiated Demo Booking",
      `${tutorName} requested a demo with ${
        studentProfile.name || "Student"
      } for ${subject} on ${date} at ${time}`,
      {
        bookingId: booking._id,
        tutorId,
        studentId,
        subject,
        date,
        time,
        type: booking.type,
        status: booking.status,
        requestedBy: booking.requestedBy,
      }
    );
  } catch (e) {
    console.warn("Notification (student/admin) failed:", e.message);
  }
}

function notifyDemoConfirmed({
  booking,
  tutorName,
  studentId,
  tutorId,
  studentEmail,
  tutorEmail,
  displayDate,
  displayTime,
  studentLink,
  tutorLink,
}) {
  setImmediate(async () => {
    try {
      if (studentEmail && notificationService?.sendEmail) {
        const html = emailTpl.bookingConfirmedHTML({
          tutorName,
          subject: booking.subject,
          date: displayDate,
          time: displayTime,
          link: studentLink,
        });
        await notificationService.sendEmail(
          studentEmail,
          "Demo Confirmed - tuitionstime",
          "",
          html
        );
      }

      if (tutorEmail && notificationService?.sendEmail) {
        const html = emailTpl.bookingConfirmedHTML({
          tutorName,
          subject: booking.subject,
          date: displayDate,
          time: displayTime,
          link: tutorLink,
        });
        await notificationService.sendEmail(
          tutorEmail,
          "Demo Confirmed - tuitionstime",
          "",
          html
        );
      }

      if (notificationService?.createInApp) {
        await notificationService.createInApp(
          studentId,
          "Demo Confirmed",
          `Your demo with ${tutorName} is confirmed for ${displayDate}${
            displayTime ? ` at ${displayTime}` : ""
          }.`,
          {
            meetingLink: studentLink,
            bookingId: booking._id,
            joinUrl: booking.joinUrl,
            startUrl: booking.startUrl,
            meetingId: booking.meetingId,
          }
        );
      }

      try {
        await notificationService.notifyUser(
          studentId,
          "Demo Confirmed",
          `Your demo with ${tutorName} is confirmed for ${displayDate}${
            displayTime ? ` at ${displayTime}` : ""
          }.`,
          {
            meetingLink: studentLink,
            bookingId: booking._id,
            joinUrl: booking.joinUrl,
            startUrl: booking.startUrl,
          }
        );
        await notificationService.notifyUser(
          tutorId,
          "Demo Confirmed",
          `${tutorName} demo confirmed`,
          {
            meetingLink: tutorLink,
            bookingId: booking._id,
            joinUrl: booking.joinUrl,
            startUrl: booking.startUrl,
          }
        );
      } catch (_) {}

      await createAdminNotification(
        "Demo Confirmed",
        `Demo confirmed for ${booking.subject} by ${tutorName} on ${displayDate}${
          displayTime ? ` at ${displayTime}` : ""
        }`,
        {
          bookingId: booking._id,
          tutorId: tutorId,
          studentId: studentId,
          meetingLink: booking.meetingLink,
          startUrl: booking.startUrl,
          joinUrl: booking.joinUrl,
          meetingId: booking.meetingId,
          preferredTime: booking.preferredTime,
          status: booking.status,
        }
      );
    } catch (e) {
      console.warn("Demo confirmed notifications failed:", e.message);
    }
  });
}

function notifyDemoCancelled({
  booking,
  tutorName,
  studentId,
  tutorId,
  studentEmail,
}) {
  setImmediate(async () => {
    try {
      if (studentEmail && notificationService?.sendEmail) {
        const html = emailTpl.bookingCancelledHTML({
          tutorName,
          subject: booking.subject,
        });
        await notificationService.sendEmail(
          studentEmail,
          "Demo Cancelled - tuitionstime",
          "",
          html
        );
      }

      if (notificationService?.createInApp) {
        await notificationService.createInApp(
          studentId,
          "Demo Cancelled",
          `Your demo with ${tutorName} was cancelled.`,
          { tutorId, bookingId: booking._id }
        );
      }

      try {
        await notificationService.notifyUser(
          studentId,
          "Demo Cancelled",
          `Your demo with ${tutorName} was cancelled.`,
          { tutorId, bookingId: booking._id }
        );
      } catch (_) {}

      await createAdminNotification(
        "Demo Cancelled",
        `Demo cancelled for ${booking.subject} by ${tutorName}`,
        {
          bookingId: booking._id,
          tutorId,
          studentId,
          preferredTime: booking.preferredTime,
          status: booking.status,
        }
      );
    } catch (e) {
      console.warn("Demo cancel notifications failed:", e.message);
    }
  });
}

exports.getStudentBookings = async (req, res) => {
  try {
    const { type } = req.query;

    let filter;

    if (type === "demo") {
      filter = {
        studentId: req.user.id,
        type: "demo",
      };
    } else if (type === "regular") {
      filter = {
        studentId: req.user.id,
        type: "regular",
      };
    } else {
      filter = {
        studentId: req.user.id,
        $or: [
          { type: "regular" },
          { type: "demo" },
        ],
      };
    }

    const bookings = await Booking.find(filter).sort({ createdAt: -1 }).lean();

    if (!bookings.length) {
      return res.json({ success: true, data: [] });
    }

    // Collect tutor userIds
    const tutorUserIds = [
      ...new Set(
        bookings
          .map((b) => (b.tutorId ? String(b.tutorId) : null))
          .filter(Boolean)
      ),
    ];

    // Fetch tutor name + rates
    const tutorProfiles = await TutorProfile.find({
      userId: { $in: tutorUserIds },
    })
      .select("userId name hourlyRate monthlyRate")
      .lean();

    // Map tutor data by userId
    const tutorDataByUserId = new Map(
      tutorProfiles.map((tp) => [
        String(tp.userId),
        {
          name: tp.name,
          hourlyRate: tp.hourlyRate ?? null,
          monthlyRate: tp.monthlyRate ?? null,
        },
      ])
    );

    // Attach tutor data to each booking
    const enriched = bookings.map((b) => {
      const tutorIdStr = b.tutorId ? String(b.tutorId) : null;
      const tutorData =
        (tutorIdStr && tutorDataByUserId.get(tutorIdStr)) || {
          name: "Your Tutor",
          hourlyRate: null,
          monthlyRate: null,
        };

      return {
        ...b,
        tutorName: tutorData.name,
        tutorHourlyRate: tutorData.hourlyRate,
        tutorMonthlyRate: tutorData.monthlyRate,
      };
    });

    res.json({ success: true, data: enriched });
  } catch (err) {
    console.error("getStudentBookings error:", err);
    res.status(500).json({
      success: false,
      message: "Failed to fetch bookings",
    });
  }
};

exports.getTutorBookings = async (req, res) => {
  try {
    const bookings = await Booking.find({ tutorId: req.user.id })
      .sort({ createdAt: -1 })
      .lean();

    if (!bookings.length) {
      return res.json({ success: true, data: [] });
    }

    const studentUserIds = [
      ...new Set(
        bookings
          .map((b) => (b.studentId ? String(b.studentId) : null))
          .filter(Boolean)
      ),
    ];

    const studentProfiles = await StudentProfile.find({
      userId: { $in: studentUserIds },
    })
      .select("userId name")
      .lean();

    const studentNameByUserId = new Map(
      studentProfiles.map((sp) => [String(sp.userId), sp.name])
    );

    const enriched = bookings.map((b) => {
      const studentIdStr = b.studentId ? String(b.studentId) : null;
      const studentName =
        (studentIdStr && studentNameByUserId.get(studentIdStr)) || "Student";

      return {
        ...b,
        studentName,
      };
    });

    res.json({ success: true, data: enriched });
  } catch (err) {
    console.error("getTutorBookings error:", err);
    res.status(500).json({
      success: false,
      message: "Failed to fetch tutor bookings",
    });
  }
};

exports.updateDemoStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    console.log("updateDemoStatus called", {
      bookingId: id,
      status,
      userId: req.user?.id,
      role: req.user?.role,
    });

    if (!["confirmed", "cancelled"].includes(status)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid status" });
    }

    const booking = await Booking.findById(id);
    if (!booking) {
      return res
        .status(404)
        .json({ success: false, message: "Booking not found" });
    }

    if (booking.tutorId.toString() !== req.user.id) {
      return res
        .status(403)
        .json({ success: false, message: "Not authorized" });
    }

    // Only allow tutors to act on student-initiated requests
    if (booking.requestedBy !== "student") {
      return res.status(400).json({
        success: false,
        message: "This booking requires student confirmation",
      });
    }

    if (status === "confirmed") {
      console.log("updateDemoStatus confirm", { bookingId: id, userId: req.user?.id });
      booking.status = "confirmed";
      if (!booking.joinUrl || !booking.startUrl) {
        await ensureDemoZoomMeeting(booking);
      }
      booking.meetingLink = booking.joinUrl || booking.meetingLink || "";
      await booking.save();

      const tutorUser = await User.findById(booking.tutorId);
      const studentUser = await User.findById(booking.studentId);
      const tutorProfile = await TutorProfile.findOne({
        userId: booking.tutorId,
      }).lean();

      const tutorName = tutorProfile?.name || "Your Tutor";
      const displayDate = new Date(booking.preferredDate).toDateString();
      const displayTime = booking.preferredTime || "";
      const studentLink = booking.joinUrl || booking.meetingLink || "";
      const tutorLink = booking.startUrl || booking.meetingLink || "";

      const notifyCtx = {
        booking,
        tutorName,
        studentId: booking.studentId,
        tutorId: booking.tutorId,
        studentEmail: studentUser?.email,
        tutorEmail: tutorUser?.email,
        displayDate,
        displayTime,
        studentLink,
        tutorLink,
      };
      void notifyDemoConfirmed(notifyCtx);

      return res.json({
        success: true,
        message:
          "Demo confirmed successfully and emails sent to both student & tutor.",
        data: booking,
      });
    }

    if (status === "cancelled") {
      console.log("updateDemoStatus cancel", { bookingId: id, userId: req.user?.id });
      booking.status = "cancelled";
      await booking.save();

      const tutorProfile = await TutorProfile.findOne({
        userId: booking.tutorId,
      }).lean();
      const studentUser = await User.findById(booking.studentId);

      const notifyCtx = {
        booking,
        tutorName: tutorProfile?.name || "Your Tutor",
        studentId: booking.studentId,
        tutorId: booking.tutorId,
        studentEmail: studentUser?.email,
      };
      void notifyDemoCancelled(notifyCtx);

      return res.json({
        success: true,
        message:
          "Demo cancelled successfully and notification sent to student.",
        data: booking,
      });
    }
  } catch (err) {
    console.error("❌ updateDemoStatus error:", err);
    res.status(500).json({
      success: false,
      message: "Failed to update booking status",
      error: err.message,
    });
  }
};

/**
 * Student joins demo meeting
 * POST /api/bookings/:id/join
 */
exports.markStudentJoined = async (req, res) => {
  try {
    const { id } = req.params;
    console.log("markStudentJoined called", { bookingId: id, userId: req.user?.id });
    const booking = await Booking.findById(id);
    if (!booking) {
      return res.status(404).json({ success: false, message: "Booking not found" });
    }
    if (booking.type !== "demo") {
      return res.status(400).json({ success: false, message: "Not a demo booking" });
    }
    if (String(booking.studentId) !== String(req.user.id)) {
      return res.status(403).json({ success: false, message: "Not authorized" });
    }
    if (["cancelled", "expired"].includes(booking.status)) {
      return res.status(400).json({ success: false, message: "Booking is not active" });
    }
    if (booking.status !== "confirmed") {
      return res.status(400).json({ success: false, message: "Demo not confirmed yet" });
    }
    if (!isDemoJoinWindowOpen(booking)) {
      return res.status(403).json({ success: false, message: "Join window closed" });
    }

    if (!booking.studentJoinedAt) {
      booking.studentJoinedAt = new Date();
      await booking.save();
      console.log("markStudentJoined set", {
        bookingId: id,
        studentJoinedAt: booking.studentJoinedAt,
      });
    }

    return res.json({
      success: true,
      meetingLink: booking.joinUrl || booking.meetingLink || "",
    });
  } catch (err) {
    console.error("markStudentJoined error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

/**
 * Tutor joins demo meeting
 * POST /api/bookings/:id/tutor-join
 */
exports.markTutorJoined = async (req, res) => {
  try {
    const { id } = req.params;
    console.log("markTutorJoined called", { bookingId: id, userId: req.user?.id });
    const booking = await Booking.findById(id);
    if (!booking) {
      return res.status(404).json({ success: false, message: "Booking not found" });
    }
    if (booking.type !== "demo") {
      return res.status(400).json({ success: false, message: "Not a demo booking" });
    }
    if (String(booking.tutorId) !== String(req.user.id)) {
      return res.status(403).json({ success: false, message: "Not authorized" });
    }
    if (["cancelled", "expired"].includes(booking.status)) {
      return res.status(400).json({ success: false, message: "Booking is not active" });
    }
    if (booking.status !== "confirmed") {
      return res.status(400).json({ success: false, message: "Demo not confirmed yet" });
    }
    if (!isDemoJoinWindowOpen(booking)) {
      return res.status(403).json({ success: false, message: "Join window closed" });
    }

    if (!booking.tutorJoinedAt) {
      booking.tutorJoinedAt = new Date();
      await booking.save();
      console.log("markTutorJoined set", {
        bookingId: id,
        tutorJoinedAt: booking.tutorJoinedAt,
      });
    }

    return res.json({
      success: true,
      meetingLink: booking.startUrl || booking.meetingLink || "",
    });
  } catch (err) {
    console.error("markTutorJoined error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};



/**
 * ✅ Student confirms/cancels a demo that was requested BY TUTOR
 * PATCH /api/bookings/:id/student-status
 * Body: { status: 'confirmed' | 'cancelled' }
 */
exports.updateDemoStatusByStudent = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    console.log("updateDemoStatusByStudent called", {
      bookingId: id,
      status,
      userId: req.user?.id,
      role: req.user?.role,
    });

    if (!["confirmed", "cancelled"].includes(status)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid status" });
    }

    const booking = await Booking.findById(id);
    if (!booking) {
      return res
        .status(404)
        .json({ success: false, message: "Booking not found" });
    }

    // Must be tutor-initiated
    if (booking.requestedBy !== "tutor") {
      return res.status(400).json({
        success: false,
        message: "This booking is not tutor-initiated",
      });
    }

    // Only the student of this booking can confirm
    if (booking.studentId.toString() !== req.user.id) {
      return res
        .status(403)
        .json({ success: false, message: "Not authorized" });
    }

    if (status === "confirmed") {
      console.log("updateDemoStatusByStudent confirm", { bookingId: id, userId: req.user?.id });
      booking.status = "confirmed";
      if (!booking.joinUrl || !booking.startUrl) {
        await ensureDemoZoomMeeting(booking);
      }
      booking.meetingLink = booking.joinUrl || booking.meetingLink || "";
      await booking.save();

      const tutorUser = await User.findById(booking.tutorId);
      const studentUser = await User.findById(booking.studentId);
      const tutorProfile = await TutorProfile.findOne({
        userId: booking.tutorId,
      }).lean();
      const studentProfile = await StudentProfile.findOne({
        userId: booking.studentId,
      }).lean();

      const tutorName = tutorProfile?.name || "Tutor";
      const studentName = studentProfile?.name || "Student";
      const displayDate = new Date(booking.preferredDate).toDateString();
      const displayTime = booking.preferredTime || "";
      const studentLink = booking.joinUrl || booking.meetingLink || "";
      const tutorLink = booking.startUrl || booking.meetingLink || "";

      // Email student
      if (studentUser?.email && notificationService?.sendEmail) {
        const html =
          emailTpl.bookingConfirmedHTML?.({
            tutorName,
            subject: booking.subject,
            date: displayDate,
            time: displayTime,
            link: studentLink,
          }) ||
          `<p>Your demo with ${tutorName} is confirmed on ${displayDate} at ${displayTime}. Meeting: ${studentLink}</p>`;

        await notificationService.sendEmail(
          studentUser.email,
          "Demo Confirmed - tuitionstime",
          "",
          html
        );
      }

      // Email tutor
      if (tutorUser?.email && notificationService?.sendEmail) {
        const html =
          emailTpl.bookingConfirmedHTML?.({
            tutorName,
            subject: booking.subject,
            date: displayDate,
            time: displayTime,
            link: tutorLink,
          }) ||
          `<p>Your demo with ${studentName} is confirmed on ${displayDate} at ${displayTime}. Meeting: ${tutorLink}</p>`;

        await notificationService.sendEmail(
          tutorUser.email,
          "Demo Confirmed - tuitionstime",
          "",
          html
        );
      }

      if (notificationService?.createInApp) {
        await notificationService.createInApp(
          booking.tutorId,
          "Demo Confirmed",
          `${studentName} confirmed your demo for ${displayDate}${
            displayTime ? ` at ${displayTime}` : ""
          }.`,
          {
            meetingLink: tutorLink,
            bookingId: booking._id,
            joinUrl: booking.joinUrl,
            startUrl: booking.startUrl,
            meetingId: booking.meetingId,
          }
        );
      }

      await createAdminNotification(
        "Tutor-Initiated Demo Confirmed",
        `Demo confirmed for ${booking.subject} between ${tutorName} and ${studentName} on ${displayDate}${
          displayTime ? ` at ${displayTime}` : ""
        }`,
        {
          bookingId: booking._id,
          tutorId: booking.tutorId,
          studentId: booking.studentId,
          meetingLink: tutorLink,
          joinUrl: booking.joinUrl,
          startUrl: booking.startUrl,
          meetingId: booking.meetingId,
          preferredTime: booking.preferredTime,
          status: booking.status,
          requestedBy: booking.requestedBy,
        }
      );

      return res.json({
        success: true,
        message: "Demo confirmed successfully.",
        data: booking,
      });
    }

    // cancelled
    if (status === "cancelled") {
      console.log("updateDemoStatusByStudent cancel", { bookingId: id, userId: req.user?.id });
      booking.status = "cancelled";
      await booking.save();

      const tutorProfile = await TutorProfile.findOne({
        userId: booking.tutorId,
      }).lean();
      const tutorUser = await User.findById(booking.tutorId);
      const studentProfile = await StudentProfile.findOne({
        userId: booking.studentId,
      }).lean();

      const tutorName = tutorProfile?.name || "Tutor";
      const studentName = studentProfile?.name || "Student";

      if (tutorUser?.email && notificationService?.sendEmail) {
        const html =
          emailTpl.bookingCancelledHTML?.({
            tutorName,
            subject: booking.subject,
          }) ||
          `<p>${studentName} cancelled the demo for ${booking.subject}.</p>`;

        await notificationService.sendEmail(
          tutorUser.email,
          "Demo Cancelled - tuitionstime",
          "",
          html
        );
      }

      if (notificationService?.createInApp) {
        await notificationService.createInApp(
          booking.tutorId,
          "Demo Cancelled",
          `${studentName} cancelled your demo request.`,
          { tutorId: booking.tutorId, bookingId: booking._id }
        );
      }

      await createAdminNotification(
        "Tutor-Initiated Demo Cancelled",
        `Demo cancelled for ${booking.subject} by ${studentName}`,
        {
          bookingId: booking._id,
          tutorId: booking.tutorId,
          studentId: booking.studentId,
          preferredTime: booking.preferredTime,
          status: booking.status,
          requestedBy: booking.requestedBy,
        }
      );

      return res.json({
        success: true,
        message: "Demo cancelled successfully.",
        data: booking,
      });
    }
  } catch (err) {
    console.error("updateDemoStatusByStudent error:", err);
    res.status(500).json({
      success: false,
      message: "Failed to update booking status",
      error: err.message,
    });
  }
};

exports.addFeedback = async (req, res) => {
  try {
    const { id } = req.params;
    const { rating, feedback } = req.body;

    const booking = await Booking.findById(id);
    if (!booking) {
      return res
        .status(404)
        .json({ success: false, message: "Booking not found" });
    }

    if (booking.studentId.toString() !== req.user.id) {
      return res
        .status(403)
        .json({ success: false, message: "Not authorized" });
    }

    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({
        success: false,
        message: "Rating must be 1–5",
      });
    }

    booking.rating = rating;
    booking.feedback = feedback || "";

    await booking.save();

    try {
      const student = await StudentProfile.findOne({
        userId: req.user.id,
      }).lean();
      const tutorProfile = await TutorProfile.findOne({
        userId: booking.tutorId,
      }).lean();
      const tutorUser = await User.findById(booking.tutorId);

      if (tutorUser?.email && notificationService?.sendEmail) {
        const html = emailTpl.tutorFeedbackReceivedHTML({
          studentName: student?.name || "A student",
          subject: booking.subject,
          rating,
          feedback,
        });
        await notificationService.sendEmail(
          tutorUser.email,
          "New Feedback Received - tuitionstime",
          "",
          html
        );
      }

      if (notificationService?.createInApp) {
        await notificationService.createInApp(
          booking.tutorId,
          "New Feedback Received",
          `${student?.name || "A student"} rated your demo ${rating}/5`,
          { bookingId: booking._id }
        );
      }

      await createAdminNotification(
        "New Demo Feedback",
        `Feedback received: ${rating}/5 for ${booking.subject}`,
        {
          bookingId: booking._id,
          tutorId: booking.tutorId,
          studentId: booking.studentId,
          rating,
          feedback,
          preferredTime: booking.preferredTime,
        }
      );
    } catch (e) {
      console.warn("Feedback email failed:", e.message);
    }

    res.json({ success: true, data: booking });
  } catch (err) {
    console.error("addFeedback error:", err);
    res.status(500).json({
      success: false,
      message: "Failed to add feedback",
    });
  }
};

// Admin-only: get booking with expanded info
exports.getBookingByIdForAdmin = async (req, res) => {
  try {
    if (req.user.role !== "admin") {
      return res
        .status(403)
        .json({ success: false, message: "Not authorized" });
    }

    const { id } = req.params;

    const booking = await Booking.findById(id).lean();
    if (!booking) {
      return res
        .status(404)
        .json({ success: false, message: "Booking not found" });
    }

    const [studentProfile, tutorProfile] = await Promise.all([
      StudentProfile.findOne({ userId: booking.studentId })
        .select("name email")
        .lean(),
      TutorProfile.findOne({ userId: booking.tutorId })
        .select("name email")
        .lean(),
    ]);

    res.json({
      success: true,
      data: {
        ...booking,
        studentName: studentProfile?.name || "Student",
        studentEmail: studentProfile?.email,
        tutorName: tutorProfile?.name || "Tutor",
        tutorEmail: tutorProfile?.email,
      },
    });
  } catch (err) {
    console.error("getBookingByIdForAdmin error:", err);
    res.status(500).json({
      success: false,
      message: "Failed to fetch booking",
    });
  }
};

// Helper: generate sessions for 4 weeks initially (for regular classes)
async function generateSessionsForRegularClass(regularClass) {
  const sessions = [];
  const { timeSlots, startDate, studentId, tutorId, _id, subject } = regularClass;

  if (!timeSlots || !timeSlots.length) return;

  const start = new Date(startDate);
  const weeksToGenerate = 4;

  const dayMap = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };

  for (let w = 0; w < weeksToGenerate; w++) {
    for (const slot of timeSlots) {
      const [hourStr, minuteStr] = (slot.time || "").split(":");
      const slotDayIndex = dayMap[slot.dayOfWeek];
      if (slotDayIndex === undefined) continue;

      const d = new Date(start);
      d.setDate(d.getDate() + w * 7);

      const diff = slotDayIndex - d.getDay();
      d.setDate(d.getDate() + diff);
      d.setHours(parseInt(hourStr, 10) || 0, parseInt(minuteStr, 10) || 0, 0, 0);

      const topic = `${subject || "Regular Class"} - ${slot.dayOfWeek || ""} ${
        slot.time || ""
      }`;
      const meeting = await zoomService.createZoomMeeting({
        topic,
        startTime: d.toISOString(),
        duration: REGULAR_SESSION_DURATION_MINUTES,
      });

      sessions.push({
        regularClassId: _id,
        studentId,
        tutorId,
        startDateTime: d,
        meetingId: meeting.id ? String(meeting.id) : "",
        meetingPassword: meeting.password || meeting.encrypted_password || "",
        startUrl: meeting.start_url || "",
        joinUrl: meeting.join_url || "",
        meetingLink: meeting.join_url || "",
        status: "scheduled",
      });
    }
  }

  if (sessions.length) {
    await Session.insertMany(sessions);
  }
}

/**
 * POST /api/bookings/:id/feedback (structured demo feedback)
 * Body: { teaching, communication, understanding, comment, likedTutor }
 */
exports.giveDemoFeedback = async (req, res) => {
  try {
    const bookingId = req.params.id;
    const { teaching, communication, understanding, comment, likedTutor } =
      req.body;
    const userId = req.user.id;

    if (
      !teaching ||
      !communication ||
      !understanding ||
      likedTutor === undefined
    ) {
      return res.status(400).json({
        success: false,
        message:
          "teaching, communication, understanding, likedTutor are required",
      });
    }

    const booking = await Booking.findById(bookingId);
    if (!booking) {
      return res
        .status(404)
        .json({ success: false, message: "Booking not found" });
    }

    // ✅ Auth: only the booked student can submit feedback
    if (booking.studentId.toString() !== userId) {
      return res
        .status(403)
        .json({ success: false, message: "Not authorized for this booking" });
    }

    if (booking.type !== "demo") {
      return res.status(400).json({
        success: false,
        message: "Only demo bookings can get feedback",
      });
    }

    if (!["confirmed", "completed"].includes(booking.status)) {
      return res.status(400).json({
        success: false,
        message: "Feedback allowed only after confirmed/completed demo",
      });
    }

    if (booking.demoFeedback && booking.demoFeedback.createdAt) {
      return res
        .status(400)
        .json({ success: false, message: "Feedback already submitted" });
    }

    const overall = Math.round(
      (teaching + communication + understanding) / 3
    );

    booking.demoFeedback = {
      teaching,
      communication,
      understanding,
      overall,
      comment: comment || "",
      likedTutor: !!likedTutor,
      createdAt: new Date(),
    };
    await booking.save();

    // update tutor rating (TutorProfile is keyed by userId)
    const tutorProfile = await TutorProfile.findOne({
      userId: booking.tutorId,
    });
    if (tutorProfile) {
      tutorProfile.ratingSum = (tutorProfile.ratingSum || 0) + overall;
      tutorProfile.ratingCount = (tutorProfile.ratingCount || 0) + 1;
      tutorProfile.rating =
        tutorProfile.ratingSum / Math.max(tutorProfile.ratingCount, 1);
      await tutorProfile.save();
    }

    // notify tutor by email + in-app
    try {
      const tutorUser = await User.findById(booking.tutorId);
      const studentProfile = await StudentProfile.findOne({
        userId: booking.studentId,
      }).lean();

      const studentName = studentProfile?.name || "Student";
      const tutorName = tutorProfile?.name || "Tutor";

      if (!likedTutor) {
        // Student rejected tutor — send distinct rejection notification
        await notificationService.notifyUser(
          booking.tutorId,
          "Student did not proceed after demo",
          `${studentName} completed the demo but chose not to continue with you. Review your demo insights to track your conversion rate.`,
          {
            type: "demo_rejection",
            bookingId: booking._id,
            studentId: booking.studentId,
            studentName,
            overall,
          }
        );
      } else {
        // Student liked tutor — standard feedback notification
        await notificationService.notifyUser(
          booking.tutorId,
          "New demo feedback received",
          `${studentName} liked your demo! Overall rating: ${overall}/5.`,
          {
            type: "demo_feedback",
            bookingId: booking._id,
            studentId: booking.studentId,
            overall,
          }
        );
      }

      if (tutorUser && notificationService?.sendEmail) {
        const subjectLine = !likedTutor
          ? `Demo feedback: ${studentName} did not proceed`
          : "New demo feedback received";
        const html =
          emailTpl.demoFeedbackToTutor?.({
            tutorName,
            studentName,
            teaching,
            communication,
            understanding,
            overall,
            comment,
            likedTutor: !!likedTutor,
          }) ||
          (!likedTutor
            ? `<p>Hi ${tutorName},</p><p>${studentName} completed the demo session but chose not to continue. Overall rating: ${overall}/5.</p><p>Check your demo insights on the dashboard to track your performance.</p>`
            : `<p>You received new demo feedback from ${studentName}. Overall: ${overall}/5</p>`);
        await notificationService.sendEmail(
          tutorUser.email,
          subjectLine,
          "",
          html
        );
      }
    } catch (err) {
      console.error("Error notifying tutor about feedback:", err);
    }

    // notify admin — distinct message when student rejects
    await createAdminNotification(
      !likedTutor ? "Student rejected tutor after demo" : "Demo feedback submitted",
      !likedTutor
        ? `A student did not proceed with tutor after completing demo (Booking: ${booking._id})`
        : `Feedback for demo booking ${booking._id}`,
      {
        bookingId: booking._id,
        tutorId: booking.tutorId,
        studentId: booking.studentId,
        overall,
        likedTutor,
        rejectedByStudent: !likedTutor,
      }
    );

    // ⭐⭐⭐ ADD HOURLY / MONTHLY RATE IN RESPONSE ⭐⭐⭐
    const tutorProfileToReturn = await TutorProfile.findOne({
      userId: booking.tutorId,
    })
      .select("name hourlyRate monthlyRate photoUrl")
      .lean();

    return res.json({
      success: true,
      message: "Feedback submitted",
      data: {
        booking,
        tutorName: tutorProfileToReturn?.name || "Tutor",
        tutorRates: {
          hourlyRate: tutorProfileToReturn?.hourlyRate || 0,
          monthlyRate: tutorProfileToReturn?.monthlyRate || 0,
        },
      },
    });
  } catch (err) {
    console.error("giveDemoFeedback error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error",
      error: err.message,
    });
  }
};

// OLD version of startRegularFromDemo (kept commented for reference)
// exports.startRegularFromDemo = async (req, res) => {
//   try {
//     const bookingId = req.params.id;
//     const {
//       planType,
//       billingType,     // "hourly" | "monthly"
//       numberOfClasses  // required only for hourly
//     } = req.body;
//
//     const userId = req.user.id;
//
//     const booking = await Booking.findById(bookingId);
//
//     if (!booking) {
//       return res.status(404).json({ success: false, message: "Booking not found" });
//     }
//
//     // Only demo can be upgraded
//     if (booking.type !== "demo") {
//       return res.status(400).json({ success: false, message: "Only demo bookings can be upgraded" });
//     }
//
//     // Student must complete demo first
//     if (booking.status !== "completed") {
//       return res.status(400).json({
//         success: false,
//         message: "Demo must be completed before subscribing",
//       });
//     }
//
//     // Auth
//     if (booking.studentId.toString() !== userId) {
//       return res.status(403).json({
//         success: false,
//         message: "You are not allowed to start regular classes for this booking",
//       });
//     }
//
//     // Validate billing type
//     if (!billingType || !["hourly", "monthly"].includes(billingType)) {
//       return res.status(400).json({
//         success: false,
//         message: "billingType must be 'hourly' or 'monthly'",
//       });
//     }
//
//     // Hourly requires number of classes
//     if (billingType === "hourly" && !numberOfClasses) {
//       return res.status(400).json({
//         success: false,
//         message: "numberOfClasses is required for hourly billing",
//       });
//     }
//
//     // planType required
//     if (!planType) {
//       return res.status(400).json({
//         success: false,
//         message: "planType is required",
//       });
//     }
//
//     // Load tutor
//     const tutorProfile = await TutorProfile.findOne({
//       userId: booking.tutorId,
//     }).lean();
//
//     if (!tutorProfile) {
//       return res.status(404).json({
//         success: false,
//         message: "Tutor profile not found",
//       });
//     }
//
//     // Tutor availability
//     const tutorAvailability = Array.isArray(tutorProfile.availability)
//       ? tutorProfile.availability
//       : [];
//
//     const today = new Date();
//     const todayStr = today.toISOString().slice(0, 10);
//
//     const futureDates = tutorAvailability
//       .filter((d) => d >= todayStr)
//       .sort();
//
//     if (!futureDates.length) {
//       return res.status(400).json({
//         success: false,
//         message: "Tutor has no upcoming availability",
//       });
//     }
//
//     const startDateStr = futureDates[0];
//     const startDateObj = toStartOfDay(startDateStr);
//
//     // Compute amount
//     let baseRate = 0;
//     if (billingType === "hourly") {
//       baseRate = tutorProfile.hourlyRate || 0;
//       if (!baseRate) {
//         return res.status(400).json({
//           success: false,
//           message: "Tutor hourlyRate not set",
//         });
//       }
//     } else {
//       baseRate = tutorProfile.monthlyRate || 0;
//       if (!baseRate) {
//         return res.status(400).json({
//           success: false,
//           message: "Tutor monthlyRate not set",
//         });
//       }
//     }
//
//     let totalAmountINR =
//       billingType === "hourly"
//         ? baseRate * Number(numberOfClasses)
//         : baseRate;
//
//     const amountPaise = Math.round(totalAmountINR * 100);
//
//     const sessionsPerWeek = 2;
//     const timeSlots = [];
//
//     // Create regular class
//     const rc = await RegularClass.create({
//       studentId: booking.studentId,
//       tutorId: booking.tutorId,
//       subject: booking.subject,
//       planType,
//       sessionsPerWeek,
//       timeSlots,
//       startDate: startDateObj,
//       amount: baseRate,
//       currency: "INR",
//       paymentStatus: "pending",
//       status: "active",
//       currentPeriodStart: startDateObj,
//       currentPeriodEnd: new Date(
//         new Date(startDateObj).setMonth(startDateObj.getMonth() + 1)
//       ),
//     });
//
//     booking.regularClassId = rc._id;
//     await booking.save();
//
//     // Create payment
//     const payment = await Payment.create({
//       regularClassId: rc._id,
//       studentId: booking.studentId,
//       tutorId: booking.tutorId,
//       type: "subscription",
//       amount: totalAmountINR,
//       currency: "INR",
//       gateway: "razorpay",
//       status: "created",
//       notes: `BillingType=${billingType}, Classes=${numberOfClasses || ""}, StartDate=${startDateStr}`,
//     });
//
//     // ----------------------------
//     // Razorpay Order Creation 🔥
//     // ----------------------------
//     const razorpay = require("../services/payments/razorpay");
//
//     // SAFE RECEIPT (always < 40 chars)
//     const receipt = `rc_${Math.random().toString(36).substring(2, 10)}`;
//
//     console.log("🔍 SAFE RECEIPT:", receipt, "LEN:", receipt.length);
//
//     // Shorten notes to avoid Razorpay 40-char limit
//     const notes = {
//       rc: rc._id.toString().slice(-8),
//       bk: booking._id.toString().slice(-8),
//       bt: billingType,
//       cls: billingType === "hourly" ? String(numberOfClasses) : "",
//       sd: startDateStr,
//     };
//
//     const order = await razorpay.orders.create({
//       amount: amountPaise,
//       currency: "INR",
//       receipt: receipt,
//       notes: notes,
//     });
//
//     payment.gatewayOrderId = order.id;
//     await payment.save();
//
//     // Admin notification
//     await createAdminNotification(
//       "Regular Classes Started (Pending Payment)",
//       `Student is about to pay for regular class ${rc._id}`,
//       {
//         bookingId: booking._id,
//         regularClassId: rc._id,
//         paymentId: payment._id,
//         billingType,
//         numberOfClasses,
//         baseRate,
//         amountToPay: totalAmountINR,
//         startDate: startDateStr,
//       }
//     );
//
//     // Final response
//     return res.json({
//       success: true,
//       message: "Regular class created. Proceed to payment.",
//       data: {
//         regularClassId: rc._id,
//         paymentId: payment._id,
//         razorpayKey: process.env.RAZORPAY_KEY_ID,
//         orderId: order.id,
//         amount: amountPaise,
//         currency: "INR",
//         startDate: startDateStr,
//         billingType,
//         baseRate,
//         totalAmountINR,
//       },
//     });
//   } catch (err) {
//     console.error("startRegularFromDemo error:", err);
//     return res.status(500).json({
//       success: false,
//       message: "Server error",
//       error: err.message,
//     });
//   }
// };

// Tutor creates a REGULAR class instance for a student
// POST /api/bookings/regular
// Body: { regularClassId, date, time, note }

exports.startRegularFromDemo = async (req, res) => {
  try {
    const bookingId = req.params.id;
    const { billingType, numberOfClasses } = req.body;
    const userId = req.user.id;

    // -------------------------------
    // 1️⃣ Fetch Booking
    // -------------------------------
    const booking = await Booking.findById(bookingId);
    if (!booking) {
      return res
        .status(404)
        .json({ success: false, message: "Booking not found" });
    }

    // Must be demo
    if (booking.type !== "demo") {
      return res.status(400).json({
        success: false,
        message: "Only demo bookings can be upgraded",
      });
    }

    // Demo must be completed
    if (booking.status !== "completed") {
      return res.status(400).json({
        success: false,
        message: "Demo must be completed before subscribing",
      });
    }

    if (!booking.demoFeedback || !booking.demoFeedback.createdAt) {
      return res.status(400).json({
        success: false,
        message: "Please submit demo feedback before subscribing",
      });
    }

    // Prevent duplicate regular class creation for same demo
    if (booking.regularClassId) {
      const rc = await RegularClass.findById(booking.regularClassId);
      if (!rc) {
        return res.status(400).json({ success: false, message: "Regular class reference missing" });
      }

      const existingPayment = await Payment.findOne({ regularClassId: rc._id, type: "subscription" }).sort({ createdAt: -1 });

      const totalAmountINR = rc.planType === "hourly" ? (rc.amount || 0) * (rc.classCount || 0) : (rc.amount || 0);
      const amountPaise = Math.round(totalAmountINR * 100);

      let orderId = existingPayment?.gatewayOrderId || null;
      let paymentId = existingPayment?._id || null;

      if (!existingPayment) {
        const payment = await Payment.create({
          regularClassId: rc._id,
          studentId: booking.studentId,
          tutorId: booking.tutorId,
          type: "subscription",
          amount: totalAmountINR,
          currency: "INR",
          gateway: "razorpay",
          status: "created",
          notes: `Existing RC resume`,
        });
        paymentId = payment._id;
      }

      if (!orderId) {
        const razorpay = require("../services/payments/razorpay");
        const receipt = `rc_${rc._id.toString().slice(-8)}_${Date.now()}`;
        const order = await razorpay.orders.create({
          amount: amountPaise,
          currency: "INR",
          receipt,
          notes: {
            rc: rc._id.toString().slice(-8),
            bk: booking._id.toString().slice(-8),
            bt: rc.planType,
            cls: rc.planType === "hourly" ? String(rc.classCount || 0) : "",
          },
        });
        orderId = order.id;
        await Payment.updateOne({ _id: paymentId }, { gatewayOrderId: order.id });
      }

      return res.json({
        success: true,
        message: "Regular class already exists. Proceed to payment.",
        data: {
          regularClassId: rc._id,
          paymentId,
          orderId,
          amount: amountPaise,
          currency: "INR",
          keyId: razorpay.getKeyId(),
          provider: "razorpay",
          startDate: rc.startDate,
          billingType: rc.planType,
          baseRate: rc.amount,
          totalAmountINR,
        },
      });
    }

    // Auth — Student only
    if (String(booking.studentId) !== String(userId)) {
      return res.status(403).json({
        success: false,
        message:
          "You are not allowed to start regular classes for this booking",
      });
    }

    // -------------------------------
    // 2️⃣ Billing type validation
    // -------------------------------
    if (!billingType || !["hourly", "monthly"].includes(billingType)) {
      return res.status(400).json({
        success: false,
        message: "billingType must be 'hourly' or 'monthly'",
      });
    }

    // Hourly requires class count
    if (billingType === "hourly" && !numberOfClasses) {
      return res.status(400).json({
        success: false,
        message: "numberOfClasses is required for hourly billing",
      });
    }

    // planType = billingType (your schema supports these values)
    const planType = billingType;

    const studentProfileDoc = await StudentProfile.findOne({
      userId: booking.studentId,
    })
      .select("_id")
      .lean();
    const studentProfileId = studentProfileDoc?._id || booking.studentId;
    console.log("Student Profile ID:", studentProfileId);

    // -------------------------------
    // 3️⃣ Tutor profile
    // -------------------------------
    const tutorProfile = await TutorProfile.findOne({
      userId: booking.tutorId,
    }).lean();
    const tutorProfileId = tutorProfile?._id || booking.tutorId;
    console.log("Tutor Profile ID:", tutorProfileId);

    if (!tutorProfile) {
      return res.status(404).json({
        success: false,
        message: "Tutor profile not found",
      });
    }

    const startDateObj = toStartOfDay(new Date());
    const startDateStr = startDateObj.toISOString().slice(0, 10);

    // -------------------------------
    // 4️⃣ Compute Amount
    // -------------------------------
    let baseRate =
      billingType === "hourly"
        ? tutorProfile.hourlyRate
        : tutorProfile.monthlyRate;

    if (!baseRate) {
      return res.status(400).json({
        success: false,
        message: `Tutor ${billingType} rate not set`,
      });
    }

    const totalAmountINR =
      billingType === "hourly"
        ? baseRate * Number(numberOfClasses)
        : baseRate;

    const amountPaise = Math.round(totalAmountINR * 100);

    // -------------------------------
    // 5️⃣ Create Regular Class
    // -------------------------------
    const rc = await RegularClass.create({
      studentId: studentProfileId,
      tutorId: tutorProfileId,
      subject: booking.subject,
      planType,
      classCount: billingType === "hourly" ? Number(numberOfClasses) : null, // 🔥 store class count
      startDate: startDateObj,
      amount: baseRate,
      currency: "INR",
      paymentStatus: "pending",
      status: "active",
      currentPeriodStart: startDateObj,
      currentPeriodEnd: new Date(
        new Date(startDateObj).setMonth(startDateObj.getMonth() + 1)
      ),
    });

    // Link regular class → booking (keep original demo type for history)
    booking.regularClassId = rc._id;
    await booking.save();

    // -------------------------------
    // 6️⃣ Create Payment record
    // -------------------------------
    const payment = await Payment.create({
      regularClassId: rc._id,
      studentId: studentProfileId,
      tutorId: tutorProfileId,
      type: "subscription",
      amount: totalAmountINR,
      currency: "INR",
      gateway: "razorpay",
      status: "created",
      notes: `BillingType=${billingType}, Classes=${
        numberOfClasses || ""
      }, StartDate=${startDateStr}`,
    });

    // -------------------------------
    // 7️⃣ Razorpay Order Creation
    // -------------------------------
    const razorpay = require("../services/payments/razorpay");

    const receipt = `rc_${Math.random().toString(36).substring(2, 10)}`;

    const order = await razorpay.orders.create({
      amount: amountPaise,
      currency: "INR",
      receipt,
      notes: {
        rc: rc._id.toString().slice(-8),
        bk: booking._id.toString().slice(-8),
        bt: billingType,
        cls: billingType === "hourly" ? numberOfClasses.toString() : "",
        sd: startDateStr,
      },
    });

    payment.gatewayOrderId = order.id;
    await payment.save();

    // -------------------------------
    // 8️⃣ Admin Notification
    // -------------------------------
    await createAdminNotification(
      "Regular Classes Started (Pending Payment)",
      `Student is subscribing to regular classes for booking ${booking._id}`,
      {
        bookingId: booking._id,
        regularClassId: rc._id,
        paymentId: payment._id,
        billingType,
        numberOfClasses,
        baseRate,
        totalAmountINR,
        startDate: startDateStr,
      }
    );

    // -------------------------------
    // 9️⃣ Response
    // -------------------------------
    return res.json({
      success: true,
      message: "Regular class created. Proceed to payment.",
      data: {
        regularClassId: rc._id,
        paymentId: payment._id,
        orderId: order.id,
        amount: amountPaise,
        currency: "INR",
        keyId: razorpay.getKeyId(),
        provider: "razorpay",
        startDate: startDateStr,
        billingType,
        baseRate,
        totalAmountINR,
      },
    });
  } catch (err) {
    console.error("startRegularFromDemo error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error",
      error: err.message,
    });
  }
};

exports.startRegularDirect = async (req, res) => {
  try {
    const tutorUserId = req.params.tutorId;
    const studentUserId = req.user.id;
    const { subject, billingType, numberOfClasses } = req.body;

    if (!subject) {
      return res.status(400).json({
        success: false,
        message: "subject is required",
      });
    }

    if (!billingType || !["hourly", "monthly"].includes(billingType)) {
      return res.status(400).json({
        success: false,
        message: "billingType must be 'hourly' or 'monthly'",
      });
    }

    if (billingType === "hourly" && !numberOfClasses) {
      return res.status(400).json({
        success: false,
        message: "numberOfClasses is required for hourly billing",
      });
    }

    const studentProfileDoc = await StudentProfile.findOne({
      userId: studentUserId,
    })
      .select("_id preferredTimes name")
      .lean();

    if (!studentProfileDoc) {
      return res.status(404).json({
        success: false,
        message: "Student profile not found",
      });
    }

    const tutorProfile = await TutorProfile.findOne({
      userId: tutorUserId,
    }).lean();

    if (!tutorProfile) {
      return res.status(404).json({
        success: false,
        message: "Tutor profile not found",
      });
    }

    const tutorSubjects = Array.isArray(tutorProfile.subjects)
      ? tutorProfile.subjects
      : [];
    if (!tutorSubjects.includes(subject)) {
      return res.status(400).json({
        success: false,
        message: "Selected subject is not offered by this tutor",
      });
    }

    const existingActiveClass = await RegularClass.findOne({
      studentId: studentProfileDoc._id,
      tutorId: tutorProfile._id,
      subject,
      status: "active",
      paymentStatus: { $in: ["pending", "paid"] },
    }).lean();

    if (existingActiveClass) {
      const existingPayment = await Payment.findOne({
        regularClassId: existingActiveClass._id,
        type: "subscription",
      })
        .sort({ createdAt: -1 })
        .lean();

      const totalAmountINR =
        existingActiveClass.planType === "hourly"
          ? Number(existingActiveClass.amount || 0) *
            Number(existingActiveClass.classCount || 0)
          : Number(existingActiveClass.amount || 0);

      return res.json({
        success: true,
        message: "Regular class already exists. Proceed to payment.",
        data: {
          regularClassId: existingActiveClass._id,
          paymentId: existingPayment?._id || null,
          startDate: existingActiveClass.startDate,
          billingType: existingActiveClass.planType,
          baseRate: existingActiveClass.amount,
          totalAmountINR,
        },
      });
    }

    const startDateObj = toStartOfDay(new Date());
    const startDateStr = startDateObj.toISOString().slice(0, 10);
    const baseRate =
      billingType === "hourly"
        ? tutorProfile.hourlyRate
        : tutorProfile.monthlyRate;

    if (!baseRate) {
      return res.status(400).json({
        success: false,
        message: `Tutor ${billingType} rate not set`,
      });
    }

    const totalAmountINR =
      billingType === "hourly"
        ? baseRate * Number(numberOfClasses)
        : baseRate;

    const rc = await RegularClass.create({
      studentId: studentProfileDoc._id,
      tutorId: tutorProfile._id,
      subject,
      planType: billingType,
      classCount: billingType === "hourly" ? Number(numberOfClasses) : null,
      startDate: startDateObj,
      amount: baseRate,
      currency: "INR",
      paymentStatus: "pending",
      status: "active",
      currentPeriodStart: startDateObj,
      currentPeriodEnd: new Date(
        new Date(startDateObj).setMonth(startDateObj.getMonth() + 1)
      ),
    });

    const payment = await Payment.create({
      regularClassId: rc._id,
      studentId: studentProfileDoc._id,
      tutorId: tutorProfile._id,
      type: "subscription",
      amount: totalAmountINR,
      currency: "INR",
      gateway: "razorpay",
      status: "created",
      notes: `DirectRegular=true, BillingType=${billingType}, Classes=${
        numberOfClasses || ""
      }, StartDate=${startDateStr}`,
    });

    await createAdminNotification(
      "Direct Regular Class Started (Pending Payment)",
      `Student ${studentProfileDoc.name || studentUserId} started regular classes directly with tutor ${tutorProfile.name || tutorUserId} for ${subject}`,
      {
        regularClassId: rc._id,
        paymentId: payment._id,
        studentId: studentUserId,
        tutorId: tutorUserId,
        subject,
        billingType,
        numberOfClasses,
        startDate: startDateStr,
      }
    );

    return res.json({
      success: true,
      message: "Regular class created. Proceed to payment.",
      data: {
        regularClassId: rc._id,
        paymentId: payment._id,
        startDate: startDateStr,
        billingType,
        baseRate,
        totalAmountINR,
        studentPreferredTimes: Array.isArray(studentProfileDoc.preferredTimes)
          ? studentProfileDoc.preferredTimes
          : [],
      },
    });
  } catch (err) {
    console.error("startRegularDirect error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error",
      error: err.message,
    });
  }
};

/**
 * GET /api/bookings/tutor/insights
 * Returns demo performance insights for the logged-in tutor:
 * total demos, completed, rejected by student, liked by student, pending, confirmed, cancelled, expired
 */
exports.getTutorDemoInsights = async (req, res) => {
  try {
    const tutorId = req.user.id;

    const [stats] = await Booking.aggregate([
      { $match: { tutorId: new (require("mongoose").Types.ObjectId)(tutorId), type: "demo" } },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          pending: { $sum: { $cond: [{ $eq: ["$status", "pending"] }, 1, 0] } },
          confirmed: { $sum: { $cond: [{ $eq: ["$status", "confirmed"] }, 1, 0] } },
          completed: { $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] } },
          cancelled: { $sum: { $cond: [{ $eq: ["$status", "cancelled"] }, 1, 0] } },
          expired: { $sum: { $cond: [{ $eq: ["$status", "expired"] }, 1, 0] } },
          studentMissed: { $sum: { $cond: [{ $eq: ["$status", "student-missed"] }, 1, 0] } },
          tutorMissed: { $sum: { $cond: [{ $eq: ["$status", "tutor-missed"] }, 1, 0] } },
          feedbackGiven: {
            $sum: { $cond: [{ $ifNull: ["$demoFeedback.createdAt", false] }, 1, 0] },
          },
          rejectedByStudent: {
            $sum: {
              $cond: [
                { $and: [
                  { $ifNull: ["$demoFeedback.createdAt", false] },
                  { $eq: ["$demoFeedback.likedTutor", false] },
                ]},
                1, 0,
              ],
            },
          },
          likedByStudent: {
            $sum: {
              $cond: [
                { $and: [
                  { $ifNull: ["$demoFeedback.createdAt", false] },
                  { $eq: ["$demoFeedback.likedTutor", true] },
                ]},
                1, 0,
              ],
            },
          },
          convertedToRegular: {
            $sum: { $cond: [{ $ifNull: ["$regularClassId", false] }, 1, 0] },
          },
          avgRating: { $avg: "$demoFeedback.overall" },
        },
      },
    ]);

    const insights = stats || {
      total: 0, pending: 0, confirmed: 0, completed: 0,
      cancelled: 0, expired: 0, studentMissed: 0, tutorMissed: 0,
      feedbackGiven: 0, rejectedByStudent: 0, likedByStudent: 0,
      convertedToRegular: 0, avgRating: null,
    };
    delete insights._id;

    // rejection rate out of demos that received feedback
    insights.rejectionRate = insights.feedbackGiven > 0
      ? Math.round((insights.rejectedByStudent / insights.feedbackGiven) * 100)
      : 0;

    insights.conversionRate = insights.feedbackGiven > 0
      ? Math.round((insights.likedByStudent / insights.feedbackGiven) * 100)
      : 0;

    if (insights.avgRating != null) {
      insights.avgRating = Math.round(insights.avgRating * 10) / 10;
    }

    return res.json({ success: true, data: insights });
  } catch (err) {
    console.error("getTutorDemoInsights error:", err);
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

