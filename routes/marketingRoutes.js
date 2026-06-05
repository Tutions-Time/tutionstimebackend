const express = require('express');
const router = express.Router();
const { authenticate, checkRole } = require('../middleware/auth');
const ctrl = require('../controllers/marketingController');

// Public endpoints
router.post('/coupons/validate', ctrl.validateCoupon);

// Admin-only management
router.use(authenticate);

router.post('/coupons', checkRole(['admin']), ctrl.createCoupon);
router.get('/coupons', checkRole(['admin']), ctrl.listCoupons);
router.put('/coupons/:id', checkRole(['admin']), ctrl.updateCoupon);

module.exports = router;
