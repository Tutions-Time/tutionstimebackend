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

// student: verify payment signature after checkout
router.post(
  "/verify",
  authenticate,
  checkRole(["student"]),
  paymentController.verifyPayment
);
// admin payouts
router.get(
  "/admin/payouts",
  authenticate,
  checkRole(["admin"]),
  paymentController.listTutorPayouts
);

// admin payment history
router.get(
  "/admin/history",
  authenticate,
  checkRole(["admin"]),
  paymentController.listSubscriptionPayments
);
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

router.get(
  "/admin/payouts",
  authenticate,
  checkRole(["admin"]),
  paymentController.listTutorPayouts
);

module.exports = router;
