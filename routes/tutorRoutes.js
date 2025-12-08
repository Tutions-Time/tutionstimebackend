const express = require('express');
const router = express.Router();
const tutorSearchController = require('../controllers/tutorSearchController');
const paymentController = require('../controllers/paymentController');
const { authenticate, checkRole } = require('../middleware/auth');

// ✅ Hybrid route — filters OR AI recommendations
router.get('/search', authenticate, tutorSearchController.searchTutors);

// ✅ Get single tutor profile
router.get('/:id', tutorSearchController.getTutorById);

// ✅ Tutor earnings summary
router.get('/earnings', authenticate, checkRole(['tutor']), paymentController.getTutorEarningsSummary);

// ✅ Tutor payout request
router.post('/payout', authenticate, checkRole(['tutor']), paymentController.requestTutorPayout);

module.exports = router;
