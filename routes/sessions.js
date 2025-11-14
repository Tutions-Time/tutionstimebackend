const express = require("express");
const router = express.Router();
const sessionController = require("../controllers/sessionController");
const { authenticate } = require("../middleware/auth");

router.patch(
  "/:id/attendance",
  authenticate,
  sessionController.markAttendance
);

module.exports = router;
