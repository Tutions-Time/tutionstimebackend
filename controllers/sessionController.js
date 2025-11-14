// controllers/sessionController.js
const mongoose = require("mongoose");
const Session = require("../models/Session");
const RegularClass = require("../models/RegularClass");
const TutorProfile = require("../models/TutorProfile");
const StudentProfile = require("../models/StudentProfile");

/**
 * Helper: build Date from "YYYY-MM-DD" + "HH:mm"
 */
function buildDateTime(dateStr, timeStr) {
  const [hourStr, minStr] = (timeStr || "00:00").split(":");
  const d = new Date(dateStr);
  d.setHours(parseInt(hourStr, 10) || 0, parseInt(minStr, 10) || 0, 0, 0);
  return d;
}

/**
 * Helper: ensure tutor owns this RegularClass
 */
async function loadRegularClassForTutor(regularClassId, tutorUserId) {
  const tutorProfile = await TutorProfile.findOne({ userId: tutorUserId });
  if (!tutorProfile) {
    throw new Error("Tutor profile not found");
  }

  const rc = await RegularClass.findById(regularClassId);
  if (!rc) {
    const err = new Error("Regular class not found");
    err.statusCode = 404;
    throw err;
  }

  if (!rc.tutorId.equals(tutorProfile._id)) {
    const err = new Error("You are not the tutor of this class");
    err.statusCode = 403;
    throw err;
  }

  return { rc, tutorProfile };
}

/**
 * Helper: check date against tutor availability (exact date strings)
 * TutorProfile.availability = ["2025-12-01", "2025-12-03", ...]
 */
function assertDateInAvailability(tutorProfile, dateStr) {
  const availability = Array.isArray(tutorProfile.availability)
    ? tutorProfile.availability
    : [];

  if (!availability.includes(dateStr)) {
    const err = new Error(
      `You can only schedule on your available dates. ${dateStr} is not in your availability.`
    );
    err.statusCode = 400;
    throw err;
  }
}

/**
 * Internal helper: actually create a Session document
 */
async function createOneSession({ rc, tutorProfile, date, startTime, endTime }) {
  // Validate with tutor availability
  assertDateInAvailability(tutorProfile, date);

  const studentId = rc.studentId; // StudentProfile _id
  const tutorId = rc.tutorId; // TutorProfile _id

  const startDateTime = buildDateTime(date, startTime);
  const endDateTime = endTime ? buildDateTime(date, endTime) : null;

  // Pre-generate _id so we can embed it in meeting link
  const _id = new mongoose.Types.ObjectId();
  const meetingLink = `https://meet.jit.si/tuitiontime-${_id.toString()}`;

  const session = await Session.create({
    _id,
    regularClassId: rc._id,
    studentId,
    tutorId,
    startDateTime,
    meetingLink,
    status: "scheduled",
    attendance: "not-marked",
    tutorNotes: "",
    ...(endDateTime ? { endDateTime } : {}),
  });

  return session;
}

/**
 * POST /api/sessions/create
 * Tutor creates a single session for a RegularClass
 * Body: { regularClassId, date, startTime, endTime }
 */
exports.createSession = async (req, res) => {
  try {
    const { regularClassId, date, startTime, endTime } = req.body;
    const tutorUserId = req.user.id;

    if (!regularClassId || !date || !startTime) {
      return res.status(400).json({
        success: false,
        message: "regularClassId, date, startTime are required",
      });
    }

    const { rc, tutorProfile } = await loadRegularClassForTutor(
      regularClassId,
      tutorUserId
    );

    // (Optional) only allow sessions if payment is done
    if (rc.paymentStatus !== "paid") {
      return res.status(400).json({
        success: false,
        message: "You can create live classes only after payment is completed",
      });
    }

    const session = await createOneSession({
      rc,
      tutorProfile,
      date,
      startTime,
      endTime,
    });

    return res.json({
      success: true,
      data: session,
    });
  } catch (err) {
    console.error("createSession error:", err);
    return res.status(err.statusCode || 500).json({
      success: false,
      message: err.message || "Failed to create session",
    });
  }
};

/**
 * POST /api/sessions/bulk-create
 * Tutor creates multiple sessions at once
 * Body: { regularClassId, sessions: [{ date, startTime, endTime }, ...] }
 */
exports.bulkCreateSessions = async (req, res) => {
  try {
    const { regularClassId, sessions } = req.body;
    const tutorUserId = req.user.id;

    if (!regularClassId || !Array.isArray(sessions) || !sessions.length) {
      return res.status(400).json({
        success: false,
        message: "regularClassId and non-empty sessions[] are required",
      });
    }

    const { rc, tutorProfile } = await loadRegularClassForTutor(
      regularClassId,
      tutorUserId
    );

    if (rc.paymentStatus !== "paid") {
      return res.status(400).json({
        success: false,
        message: "You can create live classes only after payment is completed",
      });
    }

    const created = [];
    for (const s of sessions) {
      if (!s.date || !s.startTime) {
        continue; // skip invalid rows
      }
      const session = await createOneSession({
        rc,
        tutorProfile,
        date: s.date,
        startTime: s.startTime,
        endTime: s.endTime,
      });
      created.push(session);
    }

    return res.json({
      success: true,
      count: created.length,
      data: created,
    });
  } catch (err) {
    console.error("bulkCreateSessions error:", err);
    return res.status(err.statusCode || 500).json({
      success: false,
      message: err.message || "Failed to create sessions",
    });
  }
};

/**
 * GET /api/sessions/student
 * Student sees all regular sessions for paid RegularClasses
 */
exports.getStudentSessions = async (req, res) => {
  try {
    const userId = req.user.id;

    const studentProfile = await StudentProfile.findOne({ userId });
    if (!studentProfile) {
      return res.status(400).json({
        success: false,
        message: "Student profile not found",
      });
    }

    // Only show sessions for RegularClasses where payment is done
    const paidRegularClasses = await RegularClass.find({
      studentId: studentProfile._id,
      paymentStatus: "paid",
      status: "active",
    }).select("_id");

    if (!paidRegularClasses.length) {
      return res.json({ success: true, data: [] });
    }

    const rcIds = paidRegularClasses.map((rc) => rc._id);

    const sessions = await Session.find({
      regularClassId: { $in: rcIds },
    })
      .sort({ startDateTime: 1 })
      .lean();

    return res.json({
      success: true,
      data: sessions,
    });
  } catch (err) {
    console.error("getStudentSessions error:", err);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch sessions",
    });
  }
};














// const Session = require("../models/Session");
// const { createAdminNotification } = require("../services/adminNotification");

// /**
//  * PATCH /api/sessions/:id/attendance
//  * Body: { attendance: "present" | "absent", notes? }
//  * Only tutor of that class can mark
//  */
// exports.markAttendance = async (req, res) => {
//   try {
//     const sessionId = req.params.id;
//     const { attendance, notes } = req.body;
//     const userId = req.user.id;

//     if (!["present", "absent"].includes(attendance)) {
//       return res.status(400).json({
//         success: false,
//         message: "attendance must be 'present' or 'absent'",
//       });
//     }

//     const session = await Session.findById(sessionId);
//     if (!session) {
//       return res
//         .status(404)
//         .json({ success: false, message: "Session not found" });
//     }

//     // TODO: map userId -> tutorProfileId
//     // For now just allow; in your project actually check tutorId ownership
//     session.attendance = attendance;
//     session.status = "completed";
//     session.tutorNotes = notes || "";
//     await session.save();

//     await createAdminNotification(
//       "Class attendance marked",
//       `Session ${session._id} marked as ${attendance}`,
//       { sessionId: session._id, regularClassId: session.regularClassId }
//     );

//     return res.json({
//       success: true,
//       message: "Attendance updated",
//       data: session,
//     });
//   } catch (err) {
//     console.error("markAttendance error:", err);
//     return res
//       .status(500)
//       .json({ success: false, message: "Server error", error: err.message });
//   }
// };



