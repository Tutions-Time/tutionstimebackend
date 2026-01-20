const express = require("express");
const router = express.Router();
const zoomController = require("../controllers/zoomController");

router.use(express.json());

router.post("/webhook", zoomController.handleZoomWebhook);
router.get("/webhook", zoomController.handleZoomWebhook);

module.exports = router;
