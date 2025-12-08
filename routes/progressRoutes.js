const express = require("express");
const router = express.Router();
const { authenticate, checkRole } = require("../middleware/auth");
const progressController = require("../controllers/progressController");

router.use(authenticate);

// Student progress
router.get(
  "/student/summary",
  checkRole(["student"]),
  progressController.getStudentProgressSummary
);

router.get(
  "/student/by-subject",
  checkRole(["student"]),
  progressController.getStudentProgressBySubject
);

// Tutor progress
router.get(
  "/tutor/summary",
  checkRole(["tutor"]),
  progressController.getTutorProgressSummary
);

router.get(
  "/tutor/weekly",
  checkRole(["tutor"]),
  progressController.getTutorWeeklySummary
);

// Student feedback for regular session
router.post(
  "/sessions/:id/feedback",
  checkRole(["student"]),
  progressController.giveSessionFeedback
);

router.get(
  "/student/weekly",
  checkRole(["student"]),
  progressController.getStudentWeeklySummary
);

router.get(
  "/student/time-spent",
  checkRole(["student"]),
  progressController.getStudentTimeSpentSummary
);

router.get(
  "/tutor/rating-trend",
  checkRole(["tutor"]),
  progressController.getTutorRatingTrend
);

router.get(
  "/tutor/retention",
  checkRole(["tutor"]),
  progressController.getTutorRetention
);

module.exports = router;

