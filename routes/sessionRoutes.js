// routes/sessionRoutes.js
const express = require("express");
const router = express.Router();

const { authenticate, checkRole } = require("../middleware/auth");
const uploadS3 = require("../middleware/uploadS3");
const sessionController = require("../controllers/sessionController");

// All routes require auth
router.use(authenticate);

// Tutor: upload recording
router.post(
  "/:id/upload-recording",
  checkRole(["tutor"]),
  uploadS3.single("recording"),
  sessionController.uploadRecording
);

// Tutor: upload notes
router.post(
  "/:id/upload-notes",
  checkRole(["tutor"]),
  uploadS3.single("notes"),
  sessionController.uploadNotes
);

// Tutor: upload assignment
router.post(
  "/:id/upload-assignment",
  checkRole(["tutor"]),
  uploadS3.single("assignment"),
  sessionController.uploadAssignment
);

// Student & Tutor: attendance join/leave
router.post(
  "/:id/attendance",
  checkRole(["student", "tutor"]),
  sessionController.markAttendanceEvent
);

// Tutor: mark session as completed
router.post(
  "/:id/complete",
  checkRole(["tutor"]),
  sessionController.markSessionCompleted
);

module.exports = router;
