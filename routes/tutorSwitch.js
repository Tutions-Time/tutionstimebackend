const express = require("express");
const router = express.Router();
const tutorSwitchController = require("../controllers/tutorSwitchController");
const { authenticate } = require("../middleware/auth");

router.post("/", authenticate, tutorSwitchController.createSwitchRequest);

module.exports = router;
