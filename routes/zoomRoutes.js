const express = require("express");
const router = express.Router();
const zoomController = require("../controllers/zoomController");

router.post("/webhook", zoomController.handleZoomWebhook);

module.exports = router;
