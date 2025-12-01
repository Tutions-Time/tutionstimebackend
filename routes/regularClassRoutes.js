const express = require("express");
const router = express.Router();
const { authenticate, checkRole } = require("../middleware/auth");
const regularClassController = require("../controllers/regularClassController");

router.use(authenticate);


router.get(
  "/tutor/students",
  checkRole(["tutor"]),
  regularClassController.getTutorRegularStudents
);

router.get(
  "/tutor/regular-classes",
  checkRole(["tutor"]),
  regularClassController.getTutorRegularClasses
);


router.post(
  "/tutor/regular-class/:id/schedule",
  checkRole(["tutor"]),
  regularClassController.scheduleRegularClassSessions
);

router.get(
  "/student/regular-classes",
  authenticate,
  checkRole(["student"]),
  regularClassController.getStudentRegularClasses
);

router.get(
  "/regular/:id/sessions",
  authenticate,
  checkRole(["student", "tutor"]),
  regularClassController.getRegularClassSessions
);


module.exports = router;
