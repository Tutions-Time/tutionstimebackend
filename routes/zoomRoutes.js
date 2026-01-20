const express = require("express");
const router = express.Router();
const zoomController = require("../controllers/zoomController");

// ✅ Force JSON parsing ONLY for this route
router.post("/webhook", express.json({ type: "*/*" }), zoomController.handleZoomWebhook);

module.exports = router;
