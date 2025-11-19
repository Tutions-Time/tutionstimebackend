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
