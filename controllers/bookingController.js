const Booking = require('../models/Booking');
const { markSlotBooked, releaseSlot } = require('./availabilityController');
const { createOrder } = require('../services/payments/razorpay');
const walletService = require('../services/payments/walletService');
const crypto = require('crypto');

/**
 * Create a new booking (demo or regular)
 */
exports.createBooking = async (req, res) => {
  try {
    const { tutorId, subject, date, startTime, endTime, type, amount } = req.body;

    if (!tutorId || !subject || !date || !startTime || !endTime || !type) {
      return res.status(400).json({
        success: false,
        message: 'Missing required booking information',
      });
    }

    const booking = new Booking({
      studentId: req.user.id,
      tutorId,
      subject,
      date,
      startTime,
      endTime,
      type,
      amount: amount || 0,
      status: 'pending',
      paymentStatus: 'pending',
    });

    await booking.save();

    // Mark slot as booked in availability
    try {
      await markSlotBooked(tutorId, startTime);
    } catch (e) {
      console.warn('Slot not found or already booked:', startTime);
    }

    // ✅ Send notifications
    try {
      const User = require('../models/User');
      const notificationService = require('../services/notificationService');
      const student = await User.findById(req.user.id).lean();
      const tutor = await User.findById(tutorId).lean();

      const when = new Date(startTime).toLocaleString('en-IN', {
        dateStyle: 'medium',
        timeStyle: 'short'
      });

      // In-app notifications
      await Promise.all([
        notificationService.createInApp(
          tutorId,
          'New Demo Booking',
          `${student?.name || 'A student'} booked a demo for ${subject} on ${when}.`,
          { bookingId: booking._id, type }
        ),
        notificationService.createInApp(
          student._id,
          'Demo Booked Successfully',
          `Your demo with ${tutor?.name || 'the tutor'} is scheduled on ${when}.`,
          { bookingId: booking._id, type }
        )
      ]);

      // Email placeholders
      if (tutor?.email)
        await notificationService.sendEmail(
          tutor.email,
          'New Demo Booking',
          `${student?.name || 'A student'} booked a demo on ${when}.`
        );

      if (student?.email)
        await notificationService.sendEmail(
          student.email,
          'Demo Booked Successfully',
          `Your demo with ${tutor?.name || 'the tutor'} is scheduled on ${when}.`
        );
    } catch (notifyErr) {
      console.warn('Notification error:', notifyErr.message);
    }

    res.status(201).json({
      success: true,
      data: booking,
    });

  } catch (error) {
    console.error('Error creating booking:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create booking',
    });
  }
};

/**
 * Get bookings for logged-in tutor (filtered by demo/pending)
 */
exports.getTutorBookings = async (req, res) => {
  try {
    const tutorId = req.user.id;
    const { status, type } = req.query;

    const filter = { tutorId };
    if (status) filter.status = status;
    if (type) filter.type = type;

    const bookings = await Booking.find(filter)
      .populate('studentId', 'name email')
      .sort({ startTime: 1 });

    res.status(200).json({ success: true, data: bookings });
  } catch (error) {
    console.error('Error fetching tutor bookings:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch tutor bookings' });
  }
};


/**
 * Get all bookings for current user (student or tutor)
 */
exports.getUserBookings = async (req, res) => {
  try {
    const userId = req.user.id;
    const userRole = req.user.role;

    let query = {};
    if (userRole === 'student') query.studentId = userId;
    else if (userRole === 'tutor') query.tutorId = userId;

    const bookings = await Booking.find(query)
      .populate('studentId tutorId', 'name email')
      .sort({ date: -1, startTime: -1 });

    res.status(200).json({
      success: true,
      data: bookings,
    });
  } catch (error) {
    console.error('Error fetching bookings:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch bookings',
    });
  }
};

/**
 * Update booking status (pending → confirmed → cancelled → completed)
 */
exports.updateBookingStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    // ✅ Validate new status
    const validStatuses = ['pending', 'confirmed', 'cancelled', 'completed'];
    if (!status || !validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid booking status',
      });
    }

    // ✅ Fetch booking
    const booking = await Booking.findById(id);
    if (!booking)
      return res.status(404).json({ success: false, message: 'Booking not found' });

    // ✅ Authorization
    const userId = req.user.id;
    const userRole = req.user.role;
    if (userRole === 'student' && booking.studentId.toString() !== userId)
      return res.status(403).json({ success: false, message: 'Not authorized' });
    if (userRole === 'tutor' && booking.tutorId.toString() !== userId)
      return res.status(403).json({ success: false, message: 'Not authorized' });

    // ✅ Update booking status
    booking.status = status;
    await booking.save();

    // ✅ Notify student when tutor accepts/rejects demo
    try {
      const User = require('../models/User');
      const { createInApp, sendEmail } = require('../services/notificationService');
      const student = await User.findById(booking.studentId).lean();
      const tutor = await User.findById(booking.tutorId).lean();

      if (userRole === 'tutor' && ['confirmed', 'cancelled'].includes(status)) {
        const action = status === 'confirmed' ? 'accepted' : 'declined';

        await createInApp(
          student._id,
          `Demo ${status === 'confirmed' ? 'Accepted' : 'Rejected'}`,
          `${tutor?.name || 'Tutor'} has ${action} your demo request.`,
          { bookingId: booking._id, status }
        );

        if (student?.email) {
          await sendEmail(
            student.email,
            `Demo ${status === 'confirmed' ? 'Accepted' : 'Rejected'}`,
            `Your tutor ${tutor?.name || ''} has ${action} your demo booking.`
          );
        }
      }

      // Optional: notify tutor when student cancels
      if (userRole === 'student' && status === 'cancelled') {
        await createInApp(
          booking.tutorId,
          'Demo Cancelled',
          `${student?.name || 'A student'} has cancelled the demo.`,
          { bookingId: booking._id, status }
        );

        if (tutor?.email)
          await sendEmail(
            tutor.email,
            'Demo Cancelled',
            `${student?.name || 'A student'} cancelled the demo session.`
          );
      }
    } catch (notifyErr) {
      console.warn('Notification error:', notifyErr.message);
    }

    // ✅ Handle completion logic
    if (status === 'completed') {
      const tutorId = booking.tutorId;
      const amountToCredit = booking.amount * 0.9; // 10% commission
      await walletService.creditWallet(
        tutorId,
        'tutor',
        amountToCredit,
        `Class completed (Booking #${booking._id})`,
        booking._id.toString()
      );
    }

    // ✅ Release slot if cancelled
    if (status === 'cancelled') {
      await releaseSlot(booking.tutorId, booking.startTime);
    }

    // ✅ Respond
    res.status(200).json({
      success: true,
      data: booking,
    });
  } catch (error) {
    console.error('Error updating booking:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update booking',
      error: error.message,
    });
  }
};






// ✅ Verify Razorpay payment & confirm booking
exports.verifyPayment = async (req, res) => {
  try {
    const { id } = req.params;
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    // 1️⃣ Validate input
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({
        success: false,
        message: 'Missing payment verification details',
      });
    }

    // 2️⃣ Find booking
    const booking = await Booking.findById(id);
    if (!booking) {
      return res.status(404).json({
        success: false,
        message: 'Booking not found',
      });
    }

    // 3️⃣ Verify signature using Razorpay secret key
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(razorpay_order_id + '|' + razorpay_payment_id)
      .digest('hex');

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({
        success: false,
        message: 'Payment verification failed (invalid signature)',
      });
    }

    // 4️⃣ Update booking
    booking.paymentId = razorpay_payment_id;
    booking.paymentStatus = 'completed';
    booking.status = 'confirmed';
    await booking.save();

    res.status(200).json({
      success: true,
      message: 'Payment verified successfully. Booking confirmed.',
      data: booking,
    });
  } catch (error) {
    console.error('Error verifying payment:', error);
    res.status(500).json({
      success: false,
      message: 'Server error verifying payment',
      error: error.message,
    });
  }
};


/**
 * Convert demo booking → paid class
 */
exports.convertDemoToPaid = async (req, res) => {
  try {
    const { id } = req.params;
    const booking = await Booking.findById(id);
    if (!booking)
      return res.status(404).json({ success: false, message: 'Booking not found' });

    if (booking.type !== 'demo') {
      return res.status(400).json({
        success: false,
        message: 'Only demo bookings can be converted',
      });
    }

    // Create Razorpay order (or test order if keys not set)
    const order = await createOrder({
      amountInPaise: booking.amount * 100,
      receipt: booking._id.toString(),
    });

    booking.type = 'regular';
    booking.paymentId = order.id;
    booking.paymentStatus = 'initiated';
    await booking.save();

    res.status(200).json({
      success: true,
      order,
    });
  } catch (error) {
    console.error('Error converting booking to paid:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to convert demo to paid booking',
    });
  }
};

/**
 * Add rating and feedback to a completed booking
 */
exports.addRatingAndFeedback = async (req, res) => {
  try {
    const { id } = req.params;
    const { rating, feedback } = req.body;

    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({
        success: false,
        message: 'Rating must be between 1 and 5',
      });
    }

    const booking = await Booking.findById(id);
    if (!booking)
      return res.status(404).json({ success: false, message: 'Booking not found' });

    if (req.user.role !== 'student' || booking.studentId.toString() !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: 'Only the student who booked can rate',
      });
    }

    if (booking.status !== 'completed') {
      return res.status(400).json({
        success: false,
        message: 'Can only rate completed bookings',
      });
    }

    booking.rating = rating;
    booking.feedback = feedback || '';
    await booking.save();

    res.status(200).json({
      success: true,
      data: booking,
    });
  } catch (error) {
    console.error('Error adding rating:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to add rating',
    });
  }
};
