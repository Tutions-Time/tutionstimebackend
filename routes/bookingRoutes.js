// routes/bookingRoutes.js
const express = require('express');
const router = express.Router();
const bookingController = require('../controllers/bookingController');
const { authenticate, checkRole } = require('../middleware/auth');

// 🔒 All routes require authentication
router.use(authenticate);

/**
 * @route   POST /api/bookings
 * @desc    Create a new booking (demo or regular)
 * @access  Student
 */
router.post('/', checkRole(['student']), bookingController.createBooking);

/**
 * @route   GET /api/bookings/tutor
 * @desc    Tutor bookings list
 * @access  Tutor
 */
router.get('/tutor', checkRole(['tutor']), bookingController.getTutorBookings);

/**
 * @route   GET /api/bookings
 * @desc    Get bookings of logged-in user (student/tutor)
 * @access  Authenticated users
 */
router.get('/', bookingController.getUserBookings);

/**
 * @route   POST /api/bookings/:id/payment/verify
 * @desc    Verify Razorpay payment
 * @access  Student
 */
router.post('/:id/payment/verify', checkRole(['student']), bookingController.verifyPayment);

/**
 * @route   PATCH /api/bookings/:id/status
 * @desc    Update booking status (pending → confirmed/cancelled/completed)
 * @access  Student or Tutor
 */
router.patch('/:id/status', checkRole(['student', 'tutor']), bookingController.updateBookingStatus);

/**
 * @route   POST /api/bookings/:id/convert
 * @desc    Convert demo booking → paid (create Razorpay order)
 * @access  Student
 */
router.post('/:id/convert', checkRole(['student']), bookingController.convertDemoToPaid);

/**
 * @route   PATCH /api/bookings/:id/rating
 * @desc    Add rating/feedback to completed booking
 * @access  Student
 */
router.patch('/:id/rating', checkRole(['student']), bookingController.addRatingAndFeedback);

/**
 * @route   PATCH /api/bookings/:id/cancel
 * @desc    Cancel booking (student)
 * @access  Student
 */
router.patch('/:id/cancel', checkRole(['student']), bookingController.cancelBooking);

module.exports = router;
