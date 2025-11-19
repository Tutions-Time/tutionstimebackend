// routes/sessionRoutes.js
const express = require("express");
const router = express.Router();
const sessionController = require("../controllers/sessionController");
const { authenticate, checkRole } = require("../middleware/auth");

// All session routes require login
router.use(authenticate);

/**
 * Tutor creates a single session
 * POST /api/sessions/create
 */
router.post(
  "/create",
  checkRole(["tutor"]),
  sessionController.createSession
);

/**
 * Tutor bulk creates multiple sessions
 * POST /api/sessions/bulk-create
 */
router.post(
  "/bulk-create",
  checkRole(["tutor"]),
  sessionController.bulkCreateSessions
);

/**
 * Student sees all their regular sessions (only after payment)
 * GET /api/sessions/student
 */
router.get(
  "/student",
  checkRole(["student"]),
  sessionController.getStudentSessions
);

module.exports = router;
