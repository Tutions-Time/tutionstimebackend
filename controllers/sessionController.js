// controllers/sessionController.js

const Session = require("../models/Session");
const RegularClass = require("../models/RegularClass");
const GroupBatch = require("../models/GroupBatch");


/**
 * Helper: find session and check tutor ownership
 * Admin role bypasses ownership checks
 */
async function findSessionForTutor(sessionId, tutorUserId, role = "tutor") {
  
  const session = await Session.findById(sessionId).populate("regularClassId");
  if (!session) {
    const err = new Error("Session not found");
    err.statusCode = 404;
    throw err;
  }

  // Allow admin to modify any session
  if (role !== "admin") {
    const TutorProfile = require("../models/TutorProfile");
    const tp = await TutorProfile.findOne({ userId: tutorUserId }).select("_id");
    const profileId = tp?._id;
    const allowedTutorIds = new Set();
    allowedTutorIds.add(String(tutorUserId));
    if (profileId) {
      allowedTutorIds.add(String(profileId));
    }

    const reject = () => {
      const err = new Error("Not authorized to modify this session");
      err.statusCode = 403;
      throw err;
    };

    if (session.groupBatchId) {
      const gb = await GroupBatch.findById(session.groupBatchId).select("tutorId");
      const tutorId = gb?.tutorId;
      if (!gb || !allowedTutorIds.has(String(tutorId))) {
        reject();
      }
    } else {
      const tutorId = session.regularClassId?.tutorId;
      if (!allowedTutorIds.has(String(tutorId))) {
        reject();
      }
    }
  }

  return session;
}

/**
 * Tutor: upload class recording for a session
 * POST /api/sessions/:id/upload-recording
 * Field: recording (file)
 */
exports.uploadRecording = async (req, res) => {
  try {
    const tutorUserId = req.user.id;
    const role = req.user.role;
    const sessionId = req.params.id;

    if (!req.file || !req.file.location) {
      return res.status(400).json({
        success: false,
        message: "Recording file is required",
      });
    }

    const session = await findSessionForTutor(sessionId, tutorUserId, role);

    session.recordingUrl = req.file.location;
    await session.save();

    return res.json({
      success: true,
      message: "Recording uploaded successfully",
      data: {
        sessionId: session._id,
        recordingUrl: session.recordingUrl,
      },
    });
  } catch (err) {
    console.error("uploadRecording error:", err);
    return res
      .status(err.statusCode || 500)
      .json({ success: false, message: err.message || "Server error" });
  }
};

/**
 * Tutor: upload notes for a session
 * POST /api/sessions/:id/upload-notes
 * Field: notes (file)
 */
exports.uploadNotes = async (req, res) => {
  try {
    const tutorUserId = req.user.id;
    const role = req.user.role;
    const sessionId = req.params.id;

    if (!req.file || !req.file.location) {
      return res.status(400).json({
        success: false,
        message: "Notes file is required",
      });
    }

    const session = await findSessionForTutor(sessionId, tutorUserId, role);

    session.notesUrl = req.file.location;
    await session.save();

    return res.json({
      success: true,
      message: "Notes uploaded successfully",
      data: {
        sessionId: session._id,
        notesUrl: session.notesUrl,
      },
    });
  } catch (err) {
    console.error("uploadNotes error:", err);
    return res
      .status(err.statusCode || 500)
      .json({ success: false, message: err.message || "Server error" });
  }
};

/**
 * Tutor: upload assignment for a session
 * POST /api/sessions/:id/upload-assignment
 * Field: assignment (file)
 */
exports.uploadAssignment = async (req, res) => {
  try {
    const tutorUserId = req.user.id;
    const role = req.user.role;
    const sessionId = req.params.id;

    if (!req.file || !req.file.location) {
      return res.status(400).json({
        success: false,
        message: "Assignment file is required",
      });
    }

    const session = await findSessionForTutor(sessionId, tutorUserId, role);

    session.assignmentUrl = req.file.location;
    await session.save();

    return res.json({
      success: true,
      message: "Assignment uploaded successfully",
      data: {
        sessionId: session._id,
        assignmentUrl: session.assignmentUrl,
      },
    });
  } catch (err) {
    console.error("uploadAssignment error:", err);
    return res
      .status(err.statusCode || 500)
      .json({ success: false, message: err.message || "Server error" });
  }
};

/**
 * Attendance tracking
 * POST /api/sessions/:id/attendance
 * Body: { action: "join" | "leave" }
 * Role-based: student or tutor
 */
exports.markAttendanceEvent = async (req, res) => {
  try {
    const sessionId = req.params.id;
    const userId = req.user.id;
    const role = req.user.role; // assuming auth middleware sets this
    const { action } = req.body;

    if (!["join", "leave"].includes(action)) {
      return res.status(400).json({
        success: false,
        message: "action must be 'join' or 'leave'",
      });
    }

    const session = await Session.findById(sessionId).populate("regularClassId");
    if (!session) {
      return res
        .status(404)
        .json({ success: false, message: "Session not found" });
    }

    const now = new Date();

    // For safety, verify that this user belongs to the session
    if (role === "student") {
      let authorized = false;
      const StudentProfile = require("../models/StudentProfile");
      const sp = await StudentProfile.findOne({ userId }).select("_id");
      const spId = sp?._id || userId;
      if (session.groupBatchId) {
        const gb = await GroupBatch.findById(session.groupBatchId).select("enrolled enrollmentDetails");
        const enrollment = (gb?.enrollmentDetails || []).find(e => String(e.studentId) === String(spId));
        if (enrollment && enrollment.validUntil && new Date(enrollment.validUntil) < new Date()) {
            return res.status(403).json({ success: false, message: "Subscription expired" });
        }
        authorized = !!gb && ((enrollment && new Date(enrollment.validUntil) >= new Date()) || (gb.enrolled || []).some((s) => String(s) === String(spId)));
      } else {
        authorized = String(session.regularClassId.studentId) === String(spId);
      }
      if (!authorized) {
        return res
          .status(403)
          .json({ success: false, message: "Not your session" });
      }

      if (action === "join") {
        session.studentJoinTime = now;
      } else {
        session.studentLeaveTime = now;
      }
    } else if (role === "tutor") {
      let authorized = false;
      if (session.groupBatchId) {
        const gb = await GroupBatch.findById(session.groupBatchId).select("tutorId");
        authorized = !!gb && String(gb.tutorId) === String(userId);
      } else {
        authorized = String(session.regularClassId.tutorId) === String(userId);
      }
      if (!authorized) {
        return res
          .status(403)
          .json({ success: false, message: "Not your session" });
      }

      if (action === "join") {
        session.tutorJoinTime = now;
      } else {
        session.tutorLeaveTime = now;
      }
    } else {
      return res
        .status(400)
        .json({ success: false, message: "Unsupported role for attendance" });
    }

    // Simple present/absent rule:
    // if both studentJoinTime and tutorJoinTime exist => present
    if (session.studentJoinTime && session.tutorJoinTime) {
      session.attendance = "present";
    }

    await session.save();

    return res.json({
      success: true,
      message: "Attendance event recorded",
      data: {
        sessionId: session._id,
        attendance: session.attendance,
        studentJoinTime: session.studentJoinTime,
        studentLeaveTime: session.studentLeaveTime,
        tutorJoinTime: session.tutorJoinTime,
        tutorLeaveTime: session.tutorLeaveTime,
      },
    });
  } catch (err) {
    console.error("markAttendanceEvent error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Server error" });
  }
};

/**
 * Tutor: mark session as completed
 * POST /api/sessions/:id/complete
 */
exports.markSessionCompleted = async (req, res) => {
  try {
    const tutorUserId = req.user.id;
    const role = req.user.role;
    const sessionId = req.params.id;

    const session = await findSessionForTutor(sessionId, tutorUserId, role);

    session.status = "completed";

    // if still not marked, but student joined, treat as present
    if (session.attendance === "not-marked" && session.studentJoinTime) {
      session.attendance = "present";
    }

    await session.save();

    return res.json({
      success: true,
      message: "Session marked as completed",
      data: session,
    });
  } catch (err) {
    console.error("markSessionCompleted error:", err);
    return res
      .status(err.statusCode || 500)
      .json({ success: false, message: err.message || "Server error" });
  }
};

/**
 * Auto-complete sessions after 1 hour of start time
 * Runs via setInterval from app.js
 */
exports.autoCompletePastSessions = async function autoCompletePastSessions() {
  try {
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

    const sessions = await Session.find({
      status: "scheduled",
      startDateTime: { $lte: oneHourAgo },
    });

    if (!sessions.length) return;

    for (const s of sessions) {
      s.status = "completed";
      if (s.attendance === "not-marked" && s.studentJoinTime) {
        s.attendance = "present";
      }
      await s.save();
    }
  } catch (err) {
    console.error("autoCompletePastSessions error:", err.message);
  }
};

/**
 * Join a session: returns meeting link and records attendance join event
 * POST /api/sessions/:id/join
 * Roles: student, tutor
 */
exports.joinSession = async (req, res) => {
  try {
    const sessionId = req.params.id;
    const userId = req.user.id;
    const role = req.user.role;

    const session = await Session.findById(sessionId).populate("regularClassId");
    if (!session) {
      return res.status(404).json({ success: false, message: "Session not found" });
    }

    if (!session.meetingLink) {
      return res.status(400).json({ success: false, message: "Meeting link unavailable" });
    }

    if (session.status !== "scheduled") {
      return res.status(403).json({ success: false, message: "Session is not joinable" });
    }

    // Authorize membership
    let isTutor = false;
    let isStudent = false;
    if (session.groupBatchId) {
      const gb = await GroupBatch.findById(session.groupBatchId).select("tutorId enrolled enrollmentDetails");
      const StudentProfile = require("../models/StudentProfile");
      const sp = await StudentProfile.findOne({ userId }).select("_id");
      const spId = sp?._id || userId;
      isTutor = role === "tutor" && !!gb && String(gb.tutorId) === String(userId);
      
      if (role === "student" && !!gb) {
          const enrollment = (gb.enrollmentDetails || []).find(e => String(e.studentId) === String(spId));
          if (enrollment && enrollment.validUntil) {
             if (new Date(enrollment.validUntil) < new Date()) {
                 return res.status(403).json({ success: false, message: "Subscription expired" });
             }
             isStudent = true;
          } else {
             isStudent = (gb.enrolled || []).some((s) => String(s) === String(spId));
          }
      }
    } else {
      const StudentProfile = require("../models/StudentProfile");
      const sp = await StudentProfile.findOne({ userId }).select("_id");
      const spId = sp?._id || userId;
      isTutor = role === "tutor" && String(session.regularClassId.tutorId) === String(userId);
      isStudent =
        role === "student" &&
        (String(session.regularClassId.studentId) === String(spId) ||
          String(session.regularClassId.studentId) === String(userId));
    }
    if (!isTutor && !isStudent) {
      return res.status(403).json({ success: false, message: "Not authorized" });
    }

    // Join window gating (open 5 min before, close 5 min after class end)
    const start = new Date(session.startDateTime).getTime();
    const classDurationMin = 60;
    let joinBeforeMin = 5;
    let expireAfterMin = 5;
    if (session.groupBatchId) {
      const gb = await GroupBatch.findById(session.groupBatchId).select("accessWindow");
      joinBeforeMin = gb?.accessWindow?.joinBeforeMin ?? joinBeforeMin;
      expireAfterMin = gb?.accessWindow?.expireAfterMin ?? expireAfterMin;
    }
    const end = start + classDurationMin * 60 * 1000;
    const openAt = start - joinBeforeMin * 60 * 1000;
    const closeAt = end + expireAfterMin * 60 * 1000;
    const now = Date.now();
    const canJoin = now >= openAt && now <= closeAt;
    if (!canJoin) {
      return res.status(403).json({ success: false, message: "Join window closed" });
    }

    const nowDate = new Date();
    if (isStudent) {
      session.studentJoinTime = nowDate;
    } else if (isTutor) {
      session.tutorJoinTime = nowDate;
    }

    if (session.studentJoinTime && session.tutorJoinTime) {
      session.attendance = "present";
    }

    await session.save();

    return res.json({ success: true, url: session.meetingLink });
  } catch (err) {
    console.error("joinSession error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};
