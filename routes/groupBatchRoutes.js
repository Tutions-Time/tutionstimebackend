const express = require("express");
const router = express.Router();
const { authenticate, checkRole } = require("../middleware/auth");
const rateLimit = require("express-rate-limit");
const joinLimiter = rateLimit({ windowMs: 60 * 1000, max: 20 });
const c = require("../controllers/groupBatchController");

router.use(authenticate);

router.get("/create/options", checkRole(["tutor"]), c.getCreateOptions);
router.post("/create", checkRole(["tutor"]), c.createBatch);
router.patch("/:id/edit", checkRole(["tutor"]), c.editBatch);
router.post("/:id/cancel", checkRole(["tutor"]), c.cancelBatch);
router.post("/:id/reschedule", checkRole(["tutor"]), c.rescheduleBatch);
router.get("/my", checkRole(["tutor"]), c.myBatches);
router.get("/list", c.listBatches);
router.get("/:id", c.getBatch);
router.post("/:id/join", checkRole(["student"]), joinLimiter, c.joinBatch);
router.post("/:id/leave", checkRole(["student"]), c.leaveBatch);
router.get("/:id/sessions", c.listBatchSessions);
router.post("/:id/sessions/generate", checkRole(["tutor"]), c.generateUpcomingSessions);
router.post("/:id/sessions/resync-recurring", checkRole(["tutor"]), c.resyncRecurringSessions);
router.post("/:id/sessions/ensure-links", checkRole(["tutor"]), c.ensureUpcomingSessionLinks);
router.get("/:id/roster", checkRole(["tutor"]), c.getRoster);
router.post("/:id/announce", checkRole(["tutor"]), c.broadcastAnnouncement);

module.exports = router;
