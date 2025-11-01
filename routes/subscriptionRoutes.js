const express = require('express');
const router = express.Router();
const { authenticate, checkRole } = require('../middleware/auth');
const subscriptionController = require('../controllers/subscriptionController');

router.use(authenticate);

// STEP 1: Create Razorpay order + save SubscriptionIntent (no DB subscription yet)
router.post(
  '/checkout',
  checkRole(['student']),
  subscriptionController.createCheckout
);

// STEP 2: Verify Razorpay payment and then create + activate the Subscription
// NOTE: no :id here (order is verified by order_id + authenticated student)
router.post(
  '/verify',
  checkRole(['student']),
  subscriptionController.verifyAndActivate
);

// Current user's subscriptions
router.get(
  '/my',
  checkRole(['student']),
  subscriptionController.getMySubscriptions
);

module.exports = router;
