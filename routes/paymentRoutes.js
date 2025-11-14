// routes/paymentRoutes.js
const express = require("express");
const router = express.Router();
const { authenticate, checkRole } = require("../middleware/auth");
const paymentController = require("../controllers/paymentController");

// student: create subscription-style order
router.post(
  "/create-subscription-order",
  authenticate,
  checkRole(["student"]),
  paymentController.createSubscriptionOrder
);

// razorpay webhook (must use raw body)
router.post(
  "/razorpay/webhook",
  express.raw({ type: "application/json" }),
  paymentController.razorpayWebhook
);

// admin payouts
router.get(
  "/admin/payouts/generate",
  authenticate,
  checkRole(["admin"]),
  paymentController.generateTutorPayouts
);

router.patch(
  "/admin/payouts/:id/settle",
  authenticate,
  checkRole(["admin"]),
  paymentController.settlePayout
);

module.exports = router;
