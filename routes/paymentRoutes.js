// routes/paymentRoutes.js
const express = require("express");
const router = express.Router();
const { authenticate, checkRole } = require("../middleware/auth");
const paymentController = require("../controllers/paymentController");
const rateLimit = require("express-rate-limit");

const joinLimiter = rateLimit({ windowMs: 60 * 1000, max: 10 });
const adminActionLimiter = rateLimit({ windowMs: 60 * 1000, max: 20 });

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

// group batch: create order
router.post(
  "/group/create-order",
  authenticate,
  checkRole(["student"]),
  joinLimiter,
  paymentController.createGroupOrder
);

// group batch: verify order
router.post(
  "/group/verify",
  authenticate,
  checkRole(["student"]),
  joinLimiter,
  paymentController.verifyGroupPayment
);

// notes: create order
router.post(
  "/notes/create-order",
  authenticate,
  checkRole(["student"]),
  paymentController.createNoteOrder
);
// admin payouts
router.get(
  "/admin/payouts",
  authenticate,
  checkRole(["admin"]),
  paymentController.listTutorPayouts
);

router.post(
  "/refunds/request",
  authenticate,
  checkRole(["student"]),
  paymentController.createRefundRequest
);

router.get(
  "/student/regular/:id/payment",
  authenticate,
  checkRole(["student"]),
  paymentController.getStudentRegularClassPayment
);

router.get(
  "/student/refunds",
  authenticate,
  checkRole(["student"]),
  paymentController.listStudentRefunds
);

router.get(
  "/admin/refunds",
  authenticate,
  checkRole(["admin"]),
  paymentController.listRefundRequests
);

router.patch(
  "/admin/refunds/:id",
  authenticate,
  checkRole(["admin"]),
  adminActionLimiter,
  paymentController.updateRefundRequestStatus
);

router.get(
  "/admin/note-history",
  authenticate,
  checkRole(["admin"]),
  paymentController.listNotePayments
);

// admin: combined payment history (subscription + notes)
router.get(
  "/admin/all-history",
  authenticate,
  checkRole(["admin"]),
  paymentController.listAllPaymentsHistory
);

router.get(
  "/admin/revenue-timeseries",
  authenticate,
  checkRole(["admin"]),
  paymentController.getAdminRevenueTimeseries
);

router.get(
  "/tutor/note-revenue",
  authenticate,
  checkRole(["tutor"]),
  paymentController.getTutorNoteRevenue
);

// tutor: detailed note sales history
router.get(
  "/tutor/note-history",
  authenticate,
  checkRole(["tutor"]),
  paymentController.getTutorNoteHistory
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
