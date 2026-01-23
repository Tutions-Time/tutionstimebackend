// routes/sessionRoutes.js
const express = require("express");
const router = express.Router();

const { authenticate, checkRole } = require("../middleware/auth");
const uploadS3 = require("../middleware/uploadS3");
const sessionController = require("../controllers/sessionController");

// All routes require auth
router.use(authenticate);

// Tutor/Admin: upload recording
router.post(
  "/:id/upload-recording",
  checkRole(["tutor", "admin"]),
  uploadS3.single("recording"),
  sessionController.uploadRecording
);

// Tutor/Admin: upload notes
router.post(
  "/:id/upload-notes",
  checkRole(["tutor", "admin"]),
  uploadS3.single("notes"),
  sessionController.uploadNotes
);

// Tutor/Admin: upload assignment
router.post(
  "/:id/upload-assignment",
  checkRole(["tutor", "admin"]),
  uploadS3.single("assignment"),
  sessionController.uploadAssignment
);

// Student & Tutor: attendance join/leave
router.post(
  "/:id/attendance",
  checkRole(["student", "tutor"]),
  sessionController.markAttendanceEvent
);

// Student & Tutor: join session (returns meeting link)
router.post(
  "/:id/join",
  checkRole(["student", "tutor"]),
  sessionController.joinSession
);



module.exports = router;
