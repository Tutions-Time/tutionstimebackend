// controllers/bookingController.js
const Booking = require('../models/Booking');
const Availability = require('../models/Availability');
const { markSlotBooked, releaseSlot } = require('./availabilityController');
const { createOrder } = require('../services/payments/razorpay');
const walletService = require('../services/payments/walletService');
const crypto = require('crypto');
const { createZoomMeeting } = require('../services/zoomService');
const notificationService = require('../services/notificationService');
const StudentProfile = require('../models/StudentProfile');
const TutorProfile = require('../models/TutorProfile');

exports.createBooking = async (req, res) => {
  try {
    const { tutorId, subject, date, startTime, endTime, type, amount } = req.body;

    // ✅ Validate required fields
    if (!tutorId || !subject || !date || !startTime || !endTime || !type) {
      return res.status(400).json({ success: false, message: 'Missing required booking information' });
    }

    const start = new Date(startTime);
    const end = new Date(endTime);
    if (!(start instanceof Date) || isNaN(start) || !(end instanceof Date) || isNaN(end) || end <= start) {
      return res.status(400).json({ success: false, message: 'Invalid time range' });
    }

    // ✅ 1) Ensure slot exists and is free
    const slot = await Availability.findOne({
      tutorId,
      startTime: start,
      endTime: end,
      isBooked: false,
    });
    if (!slot) {
      return res.status(400).json({ success: false, message: 'Selected slot is no longer available' });
    }

    // ✅ 2) Prevent student overlapping bookings
    const overlappingStudent = await Booking.findOne({
      studentId: req.user.id,
      startTime: { $lt: end },
      endTime: { $gt: start },
      status: { $in: ['pending', 'confirmed'] },
    });
    if (overlappingStudent) {
      return res.status(400).json({ success: false, message: 'You already have a booking during this time.' });
    }

    // ✅ 3) Create booking
    const booking = new Booking({
      studentId: req.user.id,
      tutorId,
      subject,
      date,
      startTime: start,
      endTime: end,
      type, // 'demo' | 'regular'
      amount: Number(amount) || 0,
      status: 'pending',
      paymentStatus: type === 'demo' ? 'completed' : 'pending', // demos are free
    });
    await booking.save();

    // ✅ 4) Create Zoom meeting
    try {
      const durationMins = type === 'demo' ? 15 : Math.max(1, Math.ceil((end - start) / 60000));
      const zoomMeeting = await createZoomMeeting({
        topic: `${subject} class with ${req.user.name || 'Tutor'}`,
        startTime: start.toISOString(),
        duration: durationMins,
      });

      booking.zoomLink = zoomMeeting.join_url;
      booking.zoomMeetingId = zoomMeeting.id?.toString?.() || '';
      booking.zoomPassword = zoomMeeting.password || '';
      booking.zoomStartUrl = zoomMeeting.start_url || '';
      await booking.save();

      console.log(`✅ Zoom meeting created: ${booking.zoomLink}`);
    } catch (zoomErr) {
      console.warn('⚠️ Zoom meeting creation failed:', zoomErr?.message || zoomErr);
    }

    // ✅ 5) Mark slot as booked
    try {
      await markSlotBooked(tutorId, start);
    } catch (e) {
      console.warn('⚠️ Slot mark booked failed:', e?.message || e);
    }

    // ✅ 6) Auto-confirm demo bookings
    if (type === 'demo') {
      booking.status = 'confirmed';
      booking.paymentStatus = 'completed';
      await booking.save();
    }

    // ✅ 7) Notifications (Email only)
// ✅ 7) Notifications (email with HTML)
try {
  const StudentProfile = require('../models/StudentProfile');
  const TutorProfile = require('../models/TutorProfile');
  const notificationService = require('../services/notificationService');
  const { generateBookingEmailHTML } = require('../templates/bookingSuccessEmail');

  const student = await StudentProfile.findOne({ userId: req.user.id }).lean();
  const tutor = await TutorProfile.findOne({ userId: tutorId }).lean();
  const when = new Date(start).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });

  console.log('📩 Attempting to email tutor:', tutor?.email);
  console.log('📩 Attempting to email student:', student?.email);

  // 📧 Email to tutor (simple text)
  if (tutor?.email) {
    await notificationService.sendEmail(
      tutor.email,
      type === 'demo' ? 'New Demo Booking' : 'New Class Booking',
      `${student?.name || 'A student'} booked a ${type} for ${subject} on ${when}.`
    );
  }

  // 📧 Email to student (HTML version)
  if (student?.email) {
    const htmlContent = generateBookingEmailHTML({
      studentName: student?.name,
      tutorName: tutor?.name,
      subject,
      dateTime: when,
      zoomLink: booking.zoomLink,
      type,
    });

    await notificationService.sendEmail(
      student.email,
      type === 'demo' ? 'Demo Booked Successfully' : 'Class Booked Successfully',
      `Your ${type} with ${tutor?.name || 'the tutor'} is scheduled on ${when}. Join Zoom: ${booking.zoomLink}`,
      htmlContent
    );
  }
} catch (notifyErr) {
  console.warn('⚠️ Notification error:', notifyErr?.message || notifyErr);
}


    // ✅ 8) Final response
    const tutorBasic = await TutorProfile.findOne({ userId: tutorId }).select('name email').lean();
    res.status(201).json({
      success: true,
      message: 'Booking created successfully',
      data: { booking, tutor: tutorBasic || null },
    });
  } catch (error) {
    console.error('❌ Error creating booking:', error);
    res.status(500).json({ success: false, message: 'Failed to create booking' });
  }
};

// ✅ Get bookings for logged-in tutor
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

// ✅ Get all bookings for current user
exports.getUserBookings = async (req, res) => {
  try {
    const userId = req.user.id;
    const userRole = req.user.role;

    const query =
      userRole === 'student'
        ? { studentId: userId }
        : userRole === 'tutor'
        ? { tutorId: userId }
        : { _id: null };

    const bookings = await Booking.find(query)
      .populate('studentId tutorId', 'name email')
      .sort({ date: -1, startTime: -1 });

    res.status(200).json({ success: true, data: bookings });
  } catch (error) {
    console.error('Error fetching bookings:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch bookings' });
  }
};

// ✅ Update booking status
exports.updateBookingStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const validStatuses = ['pending', 'confirmed', 'cancelled', 'completed'];
    if (!status || !validStatuses.includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid booking status' });
    }

    const booking = await Booking.findById(id);
    if (!booking) return res.status(404).json({ success: false, message: 'Booking not found' });

    const userId = req.user.id;
    const userRole = req.user.role;
    if (userRole === 'student' && booking.studentId.toString() !== userId)
      return res.status(403).json({ success: false, message: 'Not authorized' });
    if (userRole === 'tutor' && booking.tutorId.toString() !== userId)
      return res.status(403).json({ success: false, message: 'Not authorized' });

    booking.status = status;
    await booking.save();

    // ✅ Email notifications for status update
    try {
      const student = await StudentProfile.findOne({ userId: booking.studentId }).lean();
      const tutor = await TutorProfile.findOne({ userId: booking.tutorId }).lean();

      if (userRole === 'tutor' && ['confirmed', 'cancelled'].includes(status)) {
        const action = status === 'confirmed' ? 'accepted' : 'declined';
        if (student?.email) {
          await notificationService.sendEmail(
            student.email,
            `Booking ${status === 'confirmed' ? 'Accepted' : 'Rejected'}`,
            `${tutor?.name || 'Tutor'} has ${action} your ${booking.type} booking.`
          );
        }
      }

      if (userRole === 'student' && status === 'cancelled' && tutor?.email) {
        await notificationService.sendEmail(
          tutor.email,
          'Booking Cancelled',
          `${student?.name || 'A student'} has cancelled the ${booking.type}.`
        );
      }
    } catch (notifyErr) {
      console.warn('Notification error:', notifyErr?.message || notifyErr);
    }

    // ✅ Handle completion logic (wallet credit)
    if (status === 'completed' && booking.amount > 0) {
      const tutorId = booking.tutorId;
      const amountToCredit = Math.round(booking.amount * 0.9 * 100) / 100;
      await walletService.creditWallet(
        tutorId,
        'tutor',
        amountToCredit,
        `Class completed (Booking #${booking._id})`,
        booking._id.toString()
      );
    }

    // ✅ Release slot if cancelled/completed
    if (['cancelled', 'completed'].includes(status)) {
      await releaseSlot(booking.tutorId, booking.startTime);
    }

    res.status(200).json({ success: true, data: booking });
  } catch (error) {
    console.error('Error updating booking:', error);
    res.status(500).json({ success: false, message: 'Failed to update booking', error: error.message });
  }
};

// ✅ Verify Razorpay payment
exports.verifyPayment = async (req, res) => {
  try {
    const { id } = req.params;
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ success: false, message: 'Missing payment verification details' });
    }

    const booking = await Booking.findById(id);
    if (!booking) return res.status(404).json({ success: false, message: 'Booking not found' });

    // Verify signature
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(razorpay_order_id + '|' + razorpay_payment_id)
      .digest('hex');

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ success: false, message: 'Payment verification failed' });
    }

    // ✅ Only here: mark paid + convert demo → regular
    booking.paymentStatus = 'completed';
    booking.status = 'confirmed';
    booking.type = 'regular';
    booking.paymentId = razorpay_payment_id;
    await booking.save();

    return res.status(200).json({
      success: true,
      message: 'Payment verified successfully. Booking upgraded to regular.',
      data: booking,
    });
  } catch (error) {
    console.error('Error verifying payment:', error);
    res.status(500).json({ success: false, message: 'Server error verifying payment' });
  }
};


// ✅ Convert demo booking → paid
// controllers/bookingController.js
exports.convertDemoToPaid = async (req, res) => {
  try {
    const { id } = req.params;
    const booking = await Booking.findById(id);
    if (!booking) return res.status(404).json({ success: false, message: 'Booking not found' });

    if (booking.type !== 'demo') {
      return res.status(400).json({ success: false, message: 'Only demo bookings can be converted' });
    }

    // Create Razorpay order
    const order = await createOrder({
      amountInPaise: Math.max((booking.amount || 0) * 100, 100),
      receipt: booking._id.toString(),
    });

    // 👉 Do NOT change type yet, wait for payment verification
    booking.paymentStatus = 'initiated';
    booking.paymentId = order.id;
    await booking.save();

    return res.status(200).json({ success: true, order });
  } catch (error) {
    console.error('Error converting demo to paid:', error);
    res.status(500).json({ success: false, message: 'Failed to create payment order' });
  }
};


// ✅ Add rating and feedback
exports.addRatingAndFeedback = async (req, res) => {
  try {
    const { id } = req.params;
    const { rating, feedback } = req.body;

    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({ success: false, message: 'Rating must be between 1 and 5' });
    }

    const booking = await Booking.findById(id);
    if (!booking) return res.status(404).json({ success: false, message: 'Booking not found' });

    if (req.user.role !== 'student' || booking.studentId.toString() !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Only the student who booked can rate' });
    }

    if (booking.status !== 'completed') {
      return res.status(400).json({ success: false, message: 'Can only rate completed bookings' });
    }

    booking.rating = rating;
    booking.feedback = feedback || '';
    await booking.save();

    res.status(200).json({ success: true, data: booking });
  } catch (error) {
    console.error('Error adding rating:', error);
    res.status(500).json({ success: false, message: 'Failed to add rating' });
  }
};

// ✅ Cancel a booking
exports.cancelBooking = async (req, res) => {
  try {
    const { id } = req.params;
    const booking = await Booking.findById(id);
    if (!booking) return res.status(404).json({ success: false, message: 'Booking not found' });

    if (req.user.role !== 'student' || booking.studentId.toString() !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    if (booking.status === 'completed') {
      return res.status(400).json({ success: false, message: 'Cannot cancel a completed booking' });
    }

    booking.status = 'cancelled';
    await booking.save();
    await releaseSlot(booking.tutorId, booking.startTime);

    res.json({ success: true, message: 'Booking cancelled successfully', data: booking });
  } catch (err) {
    console.error('Error cancelling booking:', err);
    res.status(500).json({ success: false, message: 'Failed to cancel booking' });
  }
};
