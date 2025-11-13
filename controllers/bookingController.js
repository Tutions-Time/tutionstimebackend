const Booking = require('../models/Booking');
const TutorProfile = require('../models/TutorProfile');
const StudentProfile = require('../models/StudentProfile');
const User = require('../models/User'); // ✅ User model
const notificationService = require('../services/notificationService');
const emailTpl = require('../templates/emailTemplates');
const AdminNotification = require('../models/AdminNotification');

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || null;

// Helper: normalize YYYY-MM-DD to start-of-day Date in IST-friendly way
function toStartOfDay(dateStr) {
  const d = new Date(dateStr);
  // Force 00:00 local time for consistency
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

// ✅ Helper: admin notification (DB + optional email)
async function createAdminNotification(title, message, meta = {}) {
  try {
    // Save for admin dashboard
    await AdminNotification.create({ title, message, meta });

    // Optional email to admin
    if (ADMIN_EMAIL && notificationService?.sendEmail) {
      const html = `
        <h2>${title}</h2>
        <p>${message}</p>
        <pre style="font-size:12px;background:#f4f4f5;padding:8px;border-radius:6px;">
${JSON.stringify(meta, null, 2)}
        </pre>
      `;
      await notificationService.sendEmail(
        ADMIN_EMAIL,
        `[Admin] ${title}`,
        message,
        html
      );
    }
  } catch (err) {
    console.warn('AdminNotification create failed:', err.message);
  }
}

/**
 * POST /api/bookings/demo
 * Create a day-level demo booking (pending)
 *
 * IMPORTANT:
 * - yahan tutorId = tutor ka User._id aayega (login user id)
 */
exports.createDemoBooking = async (req, res) => {
  try {
    const { tutorId, subject, date, note } = req.body;

    if (!tutorId || !subject || !date) {
      return res.status(400).json({
        success: false,
        message: 'tutorId, subject, date are required',
      });
    }

    // ✅ TutorProfile ko userId se dhund rahe hain (tutorId = User._id)
    const tutorProfile = await TutorProfile.findOne({ userId: tutorId }).lean();
    if (!tutorProfile) {
      return res
        .status(404)
        .json({ success: false, message: 'Tutor not found' });
    }

    const preferredDate = toStartOfDay(date);

    // Availability check — assume availability is ["YYYY-MM-DD", ...]
    const avail = Array.isArray(tutorProfile.availability)
      ? tutorProfile.availability
      : [];
    const isAvailable = avail.includes(date);
    if (!isAvailable) {
      return res.status(400).json({
        success: false,
        message: 'Tutor not available on selected date',
      });
    }

    // ✅ Friendly duplicate booking error
    let booking;
    try {
      booking = await Booking.create({
        studentId: req.user.id, // User._id (student)
        tutorId, // User._id (tutor)
        subject,
        preferredDate,
        note: note || '',
        type: 'demo',
        status: 'pending',
        meetingLink: '',
      });
    } catch (err) {
      if (err.code === 11000) {
        // Requires a unique index on (studentId, tutorId, preferredDate, type)
        return res.status(400).json({
          success: false,
          message: 'You already booked a demo with this tutor for that date.',
        });
      }
      throw err;
    }

    // Notify tutor (HTML + in-app) + admin
    try {
      const student = await StudentProfile.findOne({ userId: req.user.id }).lean();
      const tutorUser = await User.findById(tutorId).lean();

      const tutorEmail = tutorProfile.email || tutorUser?.email;

      // Email to tutor if available
      if (tutorEmail && notificationService?.sendEmail) {
        const html = emailTpl.tutorDemoRequestHTML({
          studentName: student?.name || 'A student',
          subject,
          date,
        });

        await notificationService.sendEmail(
          tutorEmail,
          'New Demo Request',
          '',
          html
        );
      }

      // In-app notification to tutor (tutorId = User._id)
      if (notificationService?.createInApp) {
        await notificationService.createInApp(
          tutorId,
          'New Demo Request',
          `${student?.name || 'A student'} requested a demo for ${subject} on ${date}`,
          { tutorId, subject, date, bookingId: booking._id }
        );
      }

      // ✅ Admin notification (dashboard + email)
      await createAdminNotification(
        'New Demo Booking Created',
        `${student?.name || 'A student'} requested a demo with ${
          tutorProfile?.name || 'Tutor'
        } for ${subject} on ${date}`,
        {
          bookingId: booking._id,
          tutorId,
          studentId: req.user.id,
          subject,
          date,
          type: booking.type,
          status: booking.status,
        }
      );
    } catch (e) {
      console.warn('Notification (tutor/admin) failed:', e.message);
    }

    return res.status(201).json({ success: true, data: booking });
  } catch (err) {
    console.error('createDemoBooking error:', err);
    return res.status(500).json({
      success: false,
      message: 'Failed to create demo booking',
    });
  }
};

/**
 * GET /api/bookings/student
 * Logged-in student's demo bookings
 *
 * Yahan studentId = User._id
 * ➕ Extra: har booking ke saath tutorName add kar rahe hain (TutorProfile se)
 */
exports.getStudentBookings = async (req, res) => {
  try {
    // Raw bookings (tutorId = User._id)
    const bookings = await Booking.find({ studentId: req.user.id })
      .sort({ createdAt: -1 })
      .lean();

    if (!bookings.length) {
      return res.json({ success: true, data: [] });
    }

    // Unique tutor userIds collect karo
    const tutorUserIds = [
      ...new Set(
        bookings
          .map((b) => (b.tutorId ? String(b.tutorId) : null))
          .filter(Boolean)
      ),
    ];

    // TutorProfile se name lao
    const tutorProfiles = await TutorProfile.find({
      userId: { $in: tutorUserIds },
    })
      .select('userId name')
      .lean();

    const tutorNameByUserId = new Map(
      tutorProfiles.map((tp) => [String(tp.userId), tp.name])
    );

    // Enrich bookings with tutorName
    const enriched = bookings.map((b) => {
      const tutorIdStr = b.tutorId ? String(b.tutorId) : null;
      const tutorName =
        (tutorIdStr && tutorNameByUserId.get(tutorIdStr)) || 'Your Tutor';

      return {
        ...b,
        tutorName,
      };
    });

    res.json({ success: true, data: enriched });
  } catch (err) {
    console.error('getStudentBookings error:', err);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch bookings',
    });
  }
};

/**
 * GET /api/bookings/tutor
 * Logged-in tutor's incoming demo requests
 *
 * Yahan tutorId = User._id
 */
exports.getTutorBookings = async (req, res) => {
  try {
    const bookings = await Booking.find({ tutorId: req.user.id })
      .sort({ createdAt: -1 })
      .lean();

    if (!bookings.length) {
      return res.json({ success: true, data: [] });
    }

    const studentUserIds = [
      ...new Set(
        bookings
          .map((b) => (b.studentId ? String(b.studentId) : null))
          .filter(Boolean)
      ),
    ];

    const studentProfiles = await StudentProfile.find({
      userId: { $in: studentUserIds },
    })
      .select('userId name')
      .lean();

    const studentNameByUserId = new Map(
      studentProfiles.map((sp) => [String(sp.userId), sp.name])
    );

    const enriched = bookings.map((b) => {
      const studentIdStr = b.studentId ? String(b.studentId) : null;
      const studentName =
        (studentIdStr && studentNameByUserId.get(studentIdStr)) || 'Student';

      return {
        ...b,
        studentName,
      };
    });

    res.json({ success: true, data: enriched });
  } catch (err) {
    console.error('getTutorBookings error:', err);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch tutor bookings',
    });
  }
};


/**
 * PATCH /api/bookings/:id/status
 * Tutor accepts/rejects (confirm/cancel) a demo booking
 */
exports.updateDemoStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!['confirmed', 'cancelled'].includes(status)) {
      return res
        .status(400)
        .json({ success: false, message: 'Invalid status' });
    }

    const booking = await Booking.findById(id);
    if (!booking) {
      return res
        .status(404)
        .json({ success: false, message: 'Booking not found' });
    }

    // ✅ Only that tutor can update
    if (booking.tutorId.toString() !== req.user.id) {
      return res
        .status(403)
        .json({ success: false, message: 'Not authorized' });
    }

    // STATUS: CONFIRMED
    if (status === 'confirmed') {
      booking.status = 'confirmed';
      if (!booking.meetingLink) {
        booking.meetingLink = `https://meet.jit.si/tuitiontime-${Date.now()}`;
      }
      await booking.save();

      const tutorUser = await User.findById(booking.tutorId);
      const studentUser = await User.findById(booking.studentId);
      const tutorProfile = await TutorProfile.findOne({
        userId: booking.tutorId,
      }).lean();

      const tutorName = tutorProfile?.name || 'Your Tutor';

      // Email to Student (if email exists)
      if (studentUser?.email && notificationService?.sendEmail) {
        const html = emailTpl.bookingConfirmedHTML({
          tutorName,
          subject: booking.subject,
          date: new Date(booking.preferredDate).toDateString(),
          link: booking.meetingLink,
        });
        await notificationService.sendEmail(
          studentUser.email,
          'Demo Confirmed - TuitionTime',
          '',
          html
        );
      }

      // Email to Tutor
      if (tutorUser?.email && notificationService?.sendEmail) {
        const html = emailTpl.bookingConfirmedHTML({
          tutorName,
          subject: booking.subject,
          date: new Date(booking.preferredDate).toDateString(),
          link: booking.meetingLink,
        });
        await notificationService.sendEmail(
          tutorUser.email,
          'Demo Confirmed - TuitionTime',
          '',
          html
        );
      }

      // In-app notification to student
      if (notificationService?.createInApp) {
        await notificationService.createInApp(
          booking.studentId,
          'Demo Confirmed',
          `Your demo with ${tutorName} is confirmed.`,
          { meetingLink: booking.meetingLink, bookingId: booking._id }
        );
      }

      // ✅ Admin notification
      await createAdminNotification(
        'Demo Confirmed',
        `Demo confirmed for ${booking.subject} by ${tutorName}`,
        {
          bookingId: booking._id,
          tutorId: booking.tutorId,
          studentId: booking.studentId,
          meetingLink: booking.meetingLink,
          status: booking.status,
        }
      );

      return res.json({
        success: true,
        message:
          'Demo confirmed successfully and emails sent to both student & tutor.',
        data: booking,
      });
    }

    // STATUS: CANCELLED
    if (status === 'cancelled') {
      booking.status = 'cancelled';
      await booking.save();

      const tutorProfile = await TutorProfile.findOne({
        userId: booking.tutorId,
      }).lean();
      const studentUser = await User.findById(booking.studentId);

      const tutorName = tutorProfile?.name || 'Your Tutor';

      if (studentUser?.email && notificationService?.sendEmail) {
        const html = emailTpl.bookingCancelledHTML({
          tutorName,
          subject: booking.subject,
        });
        await notificationService.sendEmail(
          studentUser.email,
          'Demo Cancelled - TuitionTime',
          '',
          html
        );
      }

      if (notificationService?.createInApp) {
        await notificationService.createInApp(
          booking.studentId,
          'Demo Cancelled',
          `Your demo with ${tutorName} was cancelled.`,
          { tutorId: booking.tutorId, bookingId: booking._id }
        );
      }

      // ✅ Admin notification
      await createAdminNotification(
        'Demo Cancelled',
        `Demo cancelled for ${booking.subject} by ${tutorName}`,
        {
          bookingId: booking._id,
          tutorId: booking.tutorId,
          studentId: booking.studentId,
          status: booking.status,
        }
      );

      return res.json({
        success: true,
        message:
          'Demo cancelled successfully and notification sent to student.',
        data: booking,
      });
    }
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
    if (!booking) {
      return res
        .status(404)
        .json({ success: false, message: 'Booking not found' });
    }

    if (booking.studentId.toString() !== req.user.id) {
      return res
        .status(403)
        .json({ success: false, message: 'Not authorized' });
    }

    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({
        success: false,
        message: 'Rating must be 1–5',
      });
    }

    booking.rating = rating;
    booking.feedback = feedback || '';
    if (booking.status === 'confirmed') booking.status = 'completed';

    await booking.save();

    // Send feedback email & in-app notification to tutor
    try {
      const student = await StudentProfile.findOne({
        userId: req.user.id,
      }).lean();
      const tutorProfile = await TutorProfile.findOne({
        userId: booking.tutorId,
      }).lean();
      const tutorUser = await User.findById(booking.tutorId);

      if (tutorUser?.email && notificationService?.sendEmail) {
        const html = emailTpl.tutorFeedbackReceivedHTML({
          studentName: student?.name || 'A student',
          subject: booking.subject,
          rating,
          feedback,
        });
        await notificationService.sendEmail(
          tutorUser.email,
          'New Feedback Received - TuitionTime',
          '',
          html
        );
      }

      if (notificationService?.createInApp) {
        await notificationService.createInApp(
          booking.tutorId,
          'New Feedback Received',
          `${student?.name || 'A student'} rated your demo ${rating}/5`,
          { bookingId: booking._id }
        );
      }

      // ✅ Admin notification
      await createAdminNotification(
        'New Demo Feedback',
        `Feedback received: ${rating}/5 for ${booking.subject}`,
        {
          bookingId: booking._id,
          tutorId: booking.tutorId,
          studentId: booking.studentId,
          rating,
          feedback,
        }
      );
    } catch (e) {
      console.warn('Feedback email failed:', e.message);
    }

    res.json({ success: true, data: booking });
  } catch (err) {
    console.error('addFeedback error:', err);
    res.status(500).json({
      success: false,
      message: 'Failed to add feedback',
    });
  }
};
