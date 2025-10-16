const express = require('express');
const router = express.Router();
const bookingController = require('../controllers/bookingController');
const auth = require('../middleware/auth');

// All booking routes require authentication
router.use(auth.authenticate);

// Create a new booking
router.post('/', bookingController.createBooking);

// Get user's bookings
router.get('/', bookingController.getUserBookings);

// Update booking status
router.patch('/:id/status', bookingController.updateBookingStatus);

// Add rating and feedback
router.patch('/:id/rating', bookingController.addRatingAndFeedback);

module.exports = router;