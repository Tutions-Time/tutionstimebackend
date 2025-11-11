// routes/enquiryRoutes.js
const express = require('express');
const router = express.Router();
const enquiryController = require('../controllers/enquiryController');
const { authenticate, checkRole } = require('../middleware/auth');

router.use(authenticate);

/**
 * POST /api/enquiries
 * Create new enquiry (student → tutor)
 */
router.post('/', checkRole(['student']), enquiryController.createEnquiry);

/**
 * GET /api/enquiries/student
 * Logged-in student's enquiries
 */
router.get('/student', checkRole(['student']), enquiryController.getStudentEnquiries);

/**
 * GET /api/enquiries/tutor
 * Logged-in tutor's enquiries
 */
router.get('/tutor', checkRole(['tutor']), enquiryController.getTutorEnquiries);

/**
 * PATCH /api/enquiries/:id/reply
 * Tutor replies to an enquiry
 */
router.patch('/:id/reply', checkRole(['tutor']), enquiryController.replyToEnquiry);

module.exports = router;
