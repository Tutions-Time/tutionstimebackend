const TutorSwitchRequest = require("../models/TutorSwitchRequest");
const StudentProfile = require("../models/StudentProfile");
const RegularClass = require("../models/RegularClass");
const { createAdminNotification } = require("../services/adminNotification");

/**
 * POST /api/tutor-switch
 * Body: { regularClassId, reason }
 */
exports.createSwitchRequest = async (req, res) => {
  try {
    const { regularClassId, reason } = req.body;
    const userId = req.user.id;

    if (!regularClassId || !reason) {
      return res
        .status(400)
        .json({ success: false, message: "regularClassId and reason required" });
    }

    const studentProfile = await StudentProfile.findOne({ userId });
    if (!studentProfile) {
      return res
        .status(400)
        .json({ success: false, message: "Student profile not found" });
    }

    const rc = await RegularClass.findById(regularClassId);
    if (!rc || !rc.studentId.equals(studentProfile._id)) {
      return res.status(403).json({
        success: false,
        message: "You are not allowed to request switch for this class",
      });
    }

    const reqDoc = await TutorSwitchRequest.create({
      studentId: studentProfile._id,
      fromTutorId: rc.tutorId,
      regularClassId: rc._id,
      reason,
    });

    await createAdminNotification(
      "Tutor switch requested",
      `Student requested tutor change for regularClass ${rc._id}`,
      {
        switchRequestId: reqDoc._id,
        studentId: reqDoc.studentId,
        fromTutorId: reqDoc.fromTutorId,
      }
    );

    return res.json({
      success: true,
      message: "Switch request created",
      data: reqDoc,
    });
  } catch (err) {
    console.error("createSwitchRequest error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Server error", error: err.message });
  }
};
