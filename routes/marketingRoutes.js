const express = require('express');
const router = express.Router();
const { authenticate, checkRole } = require('../middleware/auth');
const ctrl = require('../controllers/marketingController');

// Public endpoints
router.post('/coupons/validate', ctrl.validateCoupon);
router.post('/referrals/apply-at-signup', ctrl.applyReferralOnSignup);

// Admin-only management
router.use(authenticate);
router.post('/referrals', checkRole(['admin']), ctrl.createReferralCode);
router.get('/referrals', checkRole(['admin']), ctrl.listReferralCodes);
router.put('/referrals/:id', checkRole(['admin']), ctrl.updateReferralCode);
router.post('/referrals/apply-settings', checkRole(['admin']), ctrl.applyReferralSettingsToCodes);
router.post('/referrals/apply-settings/student', checkRole(['admin']), ctrl.applyReferralSettingsToStudentCodes);
router.post('/referrals/apply-settings/tutor', checkRole(['admin']), ctrl.applyReferralSettingsToTutorCodes);

router.post('/coupons', checkRole(['admin']), ctrl.createCoupon);
router.get('/coupons', checkRole(['admin']), ctrl.listCoupons);
router.put('/coupons/:id', checkRole(['admin']), ctrl.updateCoupon);

// Referral settings (admin)
router.get('/referral-settings', checkRole(['admin']), ctrl.getReferralSettings);
router.put('/referral-settings', checkRole(['admin']), ctrl.updateReferralSettings);

module.exports = router;
