// routes/sessionRoutes.js
const express = require("express");
const router = express.Router();

const { authenticate, checkRole } = require("../middleware/auth");
const uploadS3 = require("../middleware/uploadS3");
const sessionController = require("../controllers/sessionController");

// All routes require auth
router.use(authenticate);

// Unified join for student & tutor
router.post(
  "/:id/join",
  checkRole(["student", "tutor"]),
  sessionController.joinSession
);

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

// Assignments per session
router.post(
  "/:id/assignments",
  checkRole(["tutor"]),
  uploadS3.fields([{ name: "files", maxCount: 5 }]),
  sessionController.createOrUpdateAssignment
);

router.get(
  "/:id/assignments",
  checkRole(["student", "tutor"]),
  sessionController.getSessionAssignments
);

router.get(
  "/assignments/:assignmentId/download-urls",
  checkRole(["student", "tutor"]),
  sessionController.getAssignmentDownloadUrls
);

router.post(
  "/assignments/:assignmentId/submit",
  checkRole(["student"]),
  uploadS3.fields([{ name: "files", maxCount: 5 }]),
  sessionController.submitAssignment
);

router.put(
  "/assignments/:assignmentId/status",
  checkRole(["tutor"]),
  sessionController.updateAssignmentStatus
);

module.exports = router;
