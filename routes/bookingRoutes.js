const express = require('express');
const router = express.Router();
const bookingController = require('../controllers/bookingController');
const { authenticate, checkRole } = require('../middleware/auth');

// All booking routes require login
router.use(authenticate);

/**
 * POST /api/bookings/demo
 * Create a new demo booking (logged-in student)
 */
router.post(
  '/demo',
  checkRole(['student']),
  bookingController.createDemoBooking
);

/**
 * ✅ NEW – Tutor creates demo request for a student
 * POST /api/bookings/tutor/demo
 */
router.post(
  '/tutor/demo',
  checkRole(['tutor']),
  bookingController.createDemoBookingByTutor
);

/**
 * GET /api/bookings/student
 * List logged-in student's demo bookings
 */
router.get(
  '/student',
  checkRole(['student']),
  bookingController.getStudentBookings
);

/**
 * GET /api/bookings/tutor
 * List logged-in tutor's incoming demo requests
 */
router.get(
  '/tutor',
  checkRole(['tutor']),
  bookingController.getTutorBookings
);

/**
 * PATCH /api/bookings/:id/status
 * Tutor accepts/rejects (confirm/cancel) a demo booking
 * (For bookings requestedBy = 'student')
 */
router.patch(
  '/:id/status',
  checkRole(['tutor']),
  bookingController.updateDemoStatus
);

/**
 * ✅ NEW – student confirms/cancels tutor-initiated demo
 * PATCH /api/bookings/:id/student-status
 * For bookings requestedBy = 'tutor'
 */
router.patch(
  '/:id/student-status',
  checkRole(['student']),
  bookingController.updateDemoStatusByStudent
);

/**
 * POST /api/bookings/:id/feedback
 * Student gives structured demo feedback
 */
router.post(
  '/:id/feedback',
  checkRole(['student']),
  bookingController.giveDemoFeedback
);

/**
 * POST /api/bookings/:id/start-regular
 * Student upgrades demo → regular classes
 */
router.post(
  '/:id/start-regular',
  checkRole(['student']),
  bookingController.startRegularFromDemo
);

module.exports = router;
