// controllers/bookingController.js
const Booking = require('../models/Booking');
const TutorProfile = require('../models/TutorProfile');
const StudentProfile = require('../models/StudentProfile');
const notificationService = require('../services/notificationService');
const emailTpl = require('../templates/emailTemplates');

// Helper: normalize YYYY-MM-DD to start-of-day Date in IST-friendly way
function toStartOfDay(dateStr) {
  const d = new Date(dateStr);
  // Force 00:00 local time for consistency
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/**
 * POST /api/bookings/demo
 * Create a day-level demo booking (pending)
 */
exports.createDemoBooking = async (req, res) => {
  console.log("data",req.body)
  try {
    const { tutorId, subject, date, note } = req.body;
    if (!tutorId || !subject || !date) {
      return res.status(400).json({ success: false, message: 'tutorId, subject, date are required' });
    }

    // Tutor must exist & be available that day (using TutorProfile.availability)
    const tutor = await TutorProfile.findOne({ _id: tutorId }).lean();
    if (!tutor) {
      return res.status(404).json({ success: false, message: 'Tutor not found' });
    }

    const preferredDate = toStartOfDay(date);
    const avail = Array.isArray(tutor.availability) ? tutor.availability : [];
    const isAvailable = avail.includes(date); // availability is stored as YYYY-MM-DD strings
    if (!isAvailable) {
      return res.status(400).json({ success: false, message: 'Tutor not available on selected date' });
    }

    const booking = await Booking.create({
      studentId: req.user.id,
      tutorId,
      subject,
      preferredDate,
      note: note || '',
      type: 'demo',
      status: 'pending',
      meetingLink: '', // set on confirm
    });
    

    // Notify tutor
    try {
      const student = await StudentProfile.findOne({ userId: req.user.id }).lean();
      if (tutor.email) {
        await notificationService.sendEmail(
          tutor.email,
          'New Demo Request',
          `${student?.name || 'A student'} requested a demo for ${subject} on ${date}.`
        );
      }
    } catch (e) {
      console.warn('Notification (tutor) failed:', e.message);
    }

    return res.status(201).json({ success: true, data: booking });
  } catch (err) {
    console.error('createDemoBooking error:', err);
    return res.status(500).json({ success: false, message: 'Failed to create demo booking' });
  }
};

/**
 * GET /api/bookings/student
 * Logged-in student's demo bookings
 */
exports.getStudentBookings = async (req, res) => {
  try {
    const bookings = await Booking.find({ studentId: req.user.id })
      .populate('tutorId', 'name email')
      .sort({ createdAt: -1 })
      .lean();

    res.json({ success: true, data: bookings });
  } catch (err) {
    console.error('getStudentBookings error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch bookings' });
  }
};

/**
 * GET /api/bookings/tutor
 * Logged-in tutor's incoming demo requests
 */
exports.getTutorBookings = async (req, res) => {
  try {
    const bookings = await Booking.find({ tutorId: req.user.id })
      .populate('studentId', 'name email')
      .sort({ createdAt: -1 })
      .lean();

    res.json({ success: true, data: bookings });
  } catch (err) {
    console.error('getTutorBookings error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch tutor bookings' });
  }
};

exports.updateDemoStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    // Validate status
    if (!['confirmed', 'cancelled'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid status' });
    }

    // Find booking
    const booking = await Booking.findById(id);
    if (!booking) {
      return res.status(404).json({ success: false, message: 'Booking not found' });
    }

    // Authorization — only tutor can confirm/cancel
    if (booking.tutorId.toString() !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    // Update booking status
    booking.status = status;

    // On confirm, generate Jitsi link
    if (status === 'confirmed' && !booking.meetingLink) {
      booking.meetingLink = `https://meet.jit.si/tuitiontime_${booking._id}`;
    }

    await booking.save();

    // Notify student via email
    try {
      const tutor = await TutorProfile.findOne({ userId: booking.tutorId }).lean();
      const student = await StudentProfile.findOne({ userId: booking.studentId }).lean();

      if (student?.email) {
        const subjectLine =
          status === 'confirmed' ? 'Demo Confirmed!' : 'Demo Cancelled';
        const html =
          status === 'confirmed'
            ? emailTpl.bookingConfirmedHTML({
                tutorName: tutor?.name || 'Your tutor',
                subject: booking.subject,
                date: new Date(booking.preferredDate).toDateString(),
                link: booking.meetingLink,
              })
            : emailTpl.bookingCancelledHTML({
                tutorName: tutor?.name || 'Your tutor',
                subject: booking.subject,
              });

        await notificationService.sendEmail(student.email, subjectLine, '', html);
      }
    } catch (e) {
      console.warn('⚠️ Notification (student) failed:', e.message);
    }

    // Return response to tutor panel
    res.json({
      success: true,
      message:
        status === 'confirmed'
          ? 'Demo confirmed successfully and email sent to student.'
          : 'Demo cancelled successfully and notification sent.',
      data: booking,
    });
  } catch (err) {
    console.error('❌ updateDemoStatus error:', err);
    res.status(500).json({
      success: false,
      message: 'Failed to update booking status',
      error: err.message,
    });
  }
};

/**
 * PATCH /api/bookings/:id/feedback
 * Student adds rating/feedback after completion
 */
exports.addFeedback = async (req, res) => {
  try {
    const { id } = req.params;
    const { rating, feedback } = req.body;

    const booking = await Booking.findById(id);
    if (!booking) return res.status(404).json({ success: false, message: 'Booking not found' });
    if (booking.studentId.toString() !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }
    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({ success: false, message: 'Rating must be 1–5' });
    }

    booking.rating = rating;
    booking.feedback = feedback || '';
    // Optional: mark completed if tutor confirmed earlier
    if (booking.status === 'confirmed') booking.status = 'completed';

    await booking.save();
    res.json({ success: true, data: booking });
  } catch (err) {
    console.error('addFeedback error:', err);
    res.status(500).json({ success: false, message: 'Failed to add feedback' });
  }
};
