const express = require("express");
const router = express.Router();
const { authenticate, checkRole } = require("../middleware/auth");
const ctrl = require("../controllers/rescheduleController");

router.use(authenticate);

router.post("/sessions/:id/requests", checkRole(["student", "tutor"]), ctrl.createRequest);
router.get("/mine", checkRole(["student", "tutor", "admin"]), ctrl.listMine);
router.post("/:id/approve", checkRole(["student", "tutor"]), ctrl.approve);
router.post("/:id/reject", checkRole(["student", "tutor"]), ctrl.reject);

module.exports = router;

