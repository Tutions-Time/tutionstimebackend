const express = require("express");
const router = express.Router();
const { authenticate, checkRole } = require("../middleware/auth");
const regularClassController = require("../controllers/regularClassController");

router.use(authenticate);

// Tutor: get all paid & active regular students
// GET /api/regular/tutor/students
router.get(
  "/tutor/students",
  checkRole(["tutor"]),
  regularClassController.getTutorRegularStudents
);

// Tutor: schedule sessions (hourly or monthly) from availability
// POST /api/regular/tutor/regular-class/:id/schedule
router.post(
  "/tutor/regular-class/:id/schedule",
  checkRole(["tutor"]),
  regularClassController.scheduleRegularClassSessions
);

module.exports = router;
