const express = require("express");
const router = express.Router();
const paymentController = require("../controllers/paymentController");
const { authenticate, requireAdmin } = require("../middleware/auth");

// Razorpay webhook (no auth; use signature verification instead)
router.post("/razorpay/webhook", paymentController.razorpayWebhook);

// Admin payouts
router.get(
  "/admin/payouts/generate",
  authenticate,
  requireAdmin,
  paymentController.generateTutorPayouts
);
router.patch(
  "/admin/payouts/:id/settle",
  authenticate,
  requireAdmin,
  paymentController.settlePayout
);

module.exports = router;
