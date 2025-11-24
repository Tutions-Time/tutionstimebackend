// controllers/sessionController.js

const Session = require("../models/Session");
const RegularClass = require("../models/RegularClass");

/**
 * Helper: find session and check tutor ownership
 */
async function findSessionForTutor(sessionId, tutorUserId) {
  const session = await Session.findById(sessionId).populate("regularClassId");
  if (!session) {
    const err = new Error("Session not found");
    err.statusCode = 404;
    throw err;
  }

  // RegularClass stores tutorId = User._id
  if (String(session.regularClassId.tutorId) !== String(tutorUserId)) {
    const err = new Error("Not authorized to modify this session");
    err.statusCode = 403;
    throw err;
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
    const sessionId = req.params.id;

    if (!req.file || !req.file.location) {
      return res.status(400).json({
        success: false,
        message: "Recording file is required",
      });
    }

    const session = await findSessionForTutor(sessionId, tutorUserId);

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
    const sessionId = req.params.id;

    if (!req.file || !req.file.location) {
      return res.status(400).json({
        success: false,
        message: "Notes file is required",
      });
    }

    const session = await findSessionForTutor(sessionId, tutorUserId);

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
    const sessionId = req.params.id;

    if (!req.file || !req.file.location) {
      return res.status(400).json({
        success: false,
        message: "Assignment file is required",
      });
    }

    const session = await findSessionForTutor(sessionId, tutorUserId);

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
      if (String(session.regularClassId.studentId) !== String(userId)) {
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
      if (String(session.regularClassId.tutorId) !== String(userId)) {
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
    const sessionId = req.params.id;

    const session = await findSessionForTutor(sessionId, tutorUserId);

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
