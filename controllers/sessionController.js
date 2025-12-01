// controllers/sessionController.js

const Session = require("../models/Session");
const RegularClass = require("../models/RegularClass");
const SessionAssignment = require("../models/SessionAssignment");
const TutorProfile = require("../models/TutorProfile");
const StudentProfile = require("../models/StudentProfile");
const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { createZoomMeeting } = require("../services/zoomService");

const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY,
    secretAccessKey: process.env.AWS_SECRET_KEY,
  },
});

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

exports.joinSession = async (req, res) => {
  try {
    const userId = req.user.id;
    const role = req.user.role;
    const { id } = req.params;

    const session = await Session.findById(id).populate("regularClassId");
    if (!session) {
      return res.status(404).json({ success: false, message: "Session not found" });
    }

    // Map user to profile ids
    const sp = await StudentProfile.findOne({ userId }).select("_id");
    const tp = await TutorProfile.findOne({ userId }).select("_id");
    const studentProfileId = sp?._id;
    const tutorProfileId = tp?._id;

    const isAssignedStudent = studentProfileId && String(session.studentId) === String(studentProfileId);
    const isAssignedTutor = tutorProfileId && String(session.tutorId) === String(tutorProfileId);

    if (!(isAssignedStudent || isAssignedTutor)) {
      return res.status(403).json({ success: false, message: "Not authorized to join this session" });
    }

    // Ensure meeting link exists
    let meetingLink = session.meetingLink;
    if (!meetingLink) {
      const topic = `Class ${String(session.regularClassId._id).slice(-6)}`;
      const startTime = new Date(session.startDateTime).toISOString();
      const meeting = await createZoomMeeting({ topic, startTime, duration: 60 });
      meetingLink = meeting.join_url;
      session.meetingLink = meetingLink;
      await session.save();
    }

    // Optionally mark join time
    const now = new Date();
    if (isAssignedStudent) session.studentJoinTime = now;
    if (isAssignedTutor) session.tutorJoinTime = now;
    await session.save();

    return res.json({ success: true, url: meetingLink });
  } catch (err) {
    console.error("joinSession error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

exports.createOrUpdateAssignment = async (req, res) => {
  try {
    const tutorUserId = req.user.id;
    const { id } = req.params; // sessionId
    const { title, description, dueDate } = req.body;

    if (!title) return res.status(400).json({ success: false, message: "title is required" });

    const session = await Session.findById(id);
    if (!session) return res.status(404).json({ success: false, message: "Session not found" });

    const tp = await TutorProfile.findOne({ userId: tutorUserId }).select("_id");
    if (!tp || String(session.tutorId) !== String(tp._id)) {
      return res.status(403).json({ success: false, message: "Not authorized" });
    }

    const tutorFileUrls = (req.files?.files || []).map((f) => f.location);
    const tutorFileKeys = (req.files?.files || []).map((f) => f.key);

    let assignment = await SessionAssignment.findOne({ sessionId: id });
    if (!assignment) {
      assignment = await SessionAssignment.create({
        sessionId: id,
        regularClassId: session.regularClassId,
        tutorId: session.tutorId,
        studentId: session.studentId,
        title,
        description: description || "",
        dueDate: dueDate ? new Date(dueDate) : undefined,
        tutorFileUrls,
        tutorFileKeys,
      });
    } else {
      assignment.title = title;
      assignment.description = description || "";
      assignment.dueDate = dueDate ? new Date(dueDate) : undefined;
      if (tutorFileUrls.length) {
        assignment.tutorFileUrls = [...assignment.tutorFileUrls, ...tutorFileUrls];
        assignment.tutorFileKeys = [...assignment.tutorFileKeys, ...tutorFileKeys];
      }
      await assignment.save();
    }

    return res.json({ success: true, data: assignment });
  } catch (err) {
    console.error("createOrUpdateAssignment error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

exports.getSessionAssignments = async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params; // sessionId
    const session = await Session.findById(id);
    if (!session) return res.status(404).json({ success: false, message: "Session not found" });

    const sp = await StudentProfile.findOne({ userId }).select("_id");
    const tp = await TutorProfile.findOne({ userId }).select("_id");
    const isAssigned = (sp && String(sp._id) === String(session.studentId)) || (tp && String(tp._id) === String(session.tutorId));
    if (!isAssigned) return res.status(403).json({ success: false, message: "Not authorized" });

    const assignment = await SessionAssignment.findOne({ sessionId: id }).lean();
    return res.json({ success: true, data: assignment || null });
  } catch (err) {
    console.error("getSessionAssignments error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

exports.getAssignmentDownloadUrls = async (req, res) => {
  try {
    const userId = req.user.id;
    const { assignmentId } = req.params;
    const assignment = await SessionAssignment.findById(assignmentId);
    if (!assignment) return res.status(404).json({ success: false, message: "Assignment not found" });

    const sp = await StudentProfile.findOne({ userId }).select("_id");
    const tp = await TutorProfile.findOne({ userId }).select("_id");
    const isAssigned = (sp && String(sp._id) === String(assignment.studentId)) || (tp && String(tp._id) === String(assignment.tutorId));
    if (!isAssigned) return res.status(403).json({ success: false, message: "Not authorized" });

    const makeSigned = async (key) => {
      const command = new GetObjectCommand({ Bucket: process.env.AWS_BUCKET, Key: key });
      return await getSignedUrl(s3, command, { expiresIn: 60 });
    };

    const tutorFiles = await Promise.all((assignment.tutorFileKeys || []).map((k) => makeSigned(k)));
    const studentFiles = await Promise.all((assignment.studentSubmissionKeys || []).map((k) => makeSigned(k)));

    return res.json({ success: true, data: { tutorFiles, studentFiles } });
  } catch (err) {
    console.error("getAssignmentDownloadUrls error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

exports.submitAssignment = async (req, res) => {
  try {
    const userId = req.user.id;
    const { assignmentId } = req.params;
    const assignment = await SessionAssignment.findById(assignmentId);
    if (!assignment) return res.status(404).json({ success: false, message: "Assignment not found" });

    const sp = await StudentProfile.findOne({ userId }).select("_id");
    if (!sp || String(sp._id) !== String(assignment.studentId)) {
      return res.status(403).json({ success: false, message: "Not authorized" });
    }

    const submissionUrls = (req.files?.files || []).map((f) => f.location);
    const submissionKeys = (req.files?.files || []).map((f) => f.key);

    assignment.studentSubmissionUrls = [...assignment.studentSubmissionUrls, ...submissionUrls];
    assignment.studentSubmissionKeys = [...assignment.studentSubmissionKeys, ...submissionKeys];
    assignment.status = "submitted";
    await assignment.save();

    return res.json({ success: true, data: assignment });
  } catch (err) {
    console.error("submitAssignment error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

exports.updateAssignmentStatus = async (req, res) => {
  try {
    const tutorUserId = req.user.id;
    const { assignmentId } = req.params;
    const { status } = req.body;

    const assignment = await SessionAssignment.findById(assignmentId);
    if (!assignment) return res.status(404).json({ success: false, message: "Assignment not found" });

    const tp = await TutorProfile.findOne({ userId: tutorUserId }).select("_id");
    if (!tp || String(tp._id) !== String(assignment.tutorId)) {
      return res.status(403).json({ success: false, message: "Not authorized" });
    }

    assignment.status = status || assignment.status;
    await assignment.save();
    return res.json({ success: true, data: assignment });
  } catch (err) {
    console.error("updateAssignmentStatus error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};
