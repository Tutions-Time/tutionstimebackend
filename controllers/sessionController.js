const Session = require("../models/Session");
const { createAdminNotification } = require("../services/adminNotification");

/**
 * PATCH /api/sessions/:id/attendance
 * Body: { attendance: "present" | "absent", notes? }
 * Only tutor of that class can mark
 */
exports.markAttendance = async (req, res) => {
  try {
    const sessionId = req.params.id;
    const { attendance, notes } = req.body;
    const userId = req.user.id;

    if (!["present", "absent"].includes(attendance)) {
      return res.status(400).json({
        success: false,
        message: "attendance must be 'present' or 'absent'",
      });
    }

    const session = await Session.findById(sessionId);
    if (!session) {
      return res
        .status(404)
        .json({ success: false, message: "Session not found" });
    }

    // TODO: map userId -> tutorProfileId
    // For now just allow; in your project actually check tutorId ownership
    session.attendance = attendance;
    session.status = "completed";
    session.tutorNotes = notes || "";
    await session.save();

    await createAdminNotification(
      "Class attendance marked",
      `Session ${session._id} marked as ${attendance}`,
      { sessionId: session._id, regularClassId: session.regularClassId }
    );

    return res.json({
      success: true,
      message: "Attendance updated",
      data: session,
    });
  } catch (err) {
    console.error("markAttendance error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Server error", error: err.message });
  }
};
