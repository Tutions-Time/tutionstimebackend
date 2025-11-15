const Booking = require('../models/Booking');
const TutorProfile = require('../models/TutorProfile');
const StudentProfile = require('../models/StudentProfile');
const RegularClass = require("../models/RegularClass");
const Session = require("../models/Session");
const Payment = require("../models/Payment");
const User = require('../models/User');
const notificationService = require('../services/notificationService');
const emailTpl = require('../templates/emailTemplates');
const AdminNotification = require('../models/AdminNotification');


const ADMIN_EMAIL = process.env.ADMIN_EMAIL || null;

function toStartOfDay(dateStr) {
  const d = new Date(dateStr);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addMinutesToTime(timeStr, minutesToAdd) {
  // timeStr in "HH:MM" 24-hr format
  const [hourStr, minuteStr] = timeStr.split(":");
  let totalMinutes = parseInt(hourStr, 10) * 60 + parseInt(minuteStr, 10);
  totalMinutes += minutesToAdd;

  const newHour = Math.floor(totalMinutes / 60) % 24;
  const newMinute = totalMinutes % 60;

  return `${String(newHour).padStart(2, "0")}:${String(newMinute).padStart(2, "0")}`;
}


async function createAdminNotification(title, message, meta = {}) {
  try {
    await AdminNotification.create({ title, message, meta });

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

exports.createDemoBooking = async (req, res) => {
  try {
    const { tutorId, subject, date, time, note } = req.body;
    console.log('createDemoBooking req.body:', req.body);

    if (!tutorId || !subject || !date || !time) {
      return res.status(400).json({
        success: false,
        message: 'tutorId, subject, date, time are required',
      });
    }

    const tutorProfile = await TutorProfile.findOne({ userId: tutorId }).lean();
    if (!tutorProfile) {
      return res
        .status(404)
        .json({ success: false, message: 'Tutor not found' });
    }

    const preferredDate = toStartOfDay(date);

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

    const existingForSameStudent = await Booking.findOne({
      studentId: req.user.id,
      tutorId,
      type: 'demo',
      preferredDate,
      preferredTime: time,
      status: { $ne: 'cancelled' },
    });

    if (existingForSameStudent) {
      return res.status(400).json({
        success: false,
        message:
          'You already booked a demo with this tutor for this time slot.',
      });
    }

    const existingSlotForTutor = await Booking.findOne({
      tutorId,
      type: 'demo',
      preferredDate,
      preferredTime: time,
      status: { $in: ['pending', 'confirmed'] },
    });

    if (
      existingSlotForTutor &&
      existingSlotForTutor.studentId.toString() !== req.user.id
    ) {
      return res.status(400).json({
        success: false,
        message: 'This time slot is already booked for this tutor.',
      });
    }

    const booking = await Booking.create({
      studentId: req.user.id,
      tutorId,
      subject,
      preferredDate,
      preferredTime: time,
      note: note || '',
      type: 'demo',
      status: 'pending',
      meetingLink: '',
    });

    try {
      const student = await StudentProfile.findOne({
        userId: req.user.id,
      }).lean();
      const tutorUser = await User.findById(tutorId).lean();

      const tutorEmail = tutorProfile.email || tutorUser?.email;

      if (tutorEmail && notificationService?.sendEmail) {
        const html = emailTpl.tutorDemoRequestHTML({
          studentName: student?.name || 'A student',
          subject,
          date,
          time,
        });

        await notificationService.sendEmail(
          tutorEmail,
          'New Demo Request',
          '',
          html
        );
      }

      if (notificationService?.createInApp) {
        await notificationService.createInApp(
          tutorId,
          'New Demo Request',
          `${student?.name || 'A student'} requested a demo for ${subject} on ${date} at ${time}`,
          { tutorId, subject, date, time, bookingId: booking._id }
        );
      }

      await createAdminNotification(
        'New Demo Booking Created',
        `${student?.name || 'A student'} requested a demo with ${tutorProfile?.name || 'Tutor'
        } for ${subject} on ${date} at ${time}`,
        {
          bookingId: booking._id,
          tutorId,
          studentId: req.user.id,
          subject,
          date,
          time,
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
 * ✅ Tutor-initiated Demo Booking
 * POST /api/bookings/tutor/demo
 * Body: { studentId, subject, date, time, note }
 * - studentId = User._id of the student
 * - tutorId = req.user.id (logged in tutor)
 */
exports.createDemoBookingByTutor = async (req, res) => {
  try {
    const tutorId = req.user.id; // logged-in tutor
    const { studentId, subject, date, time, note } = req.body;
    console.log('createDemoBookingByTutor req.body:', req.body);

    if (!studentId || !subject || !date || !time) {
      return res.status(400).json({
        success: false,
        message: 'studentId, subject, date, time are required',
      });
    }

    // Tutor profile (who is sending request)
    const tutorProfile = await TutorProfile.findOne({ userId: tutorId }).lean();
    if (!tutorProfile) {
      return res
        .status(404)
        .json({ success: false, message: 'Tutor profile not found' });
    }

    // Student profile (who receives request)
    const studentProfile = await StudentProfile.findOne({
      userId: studentId,
    }).lean();
    if (!studentProfile) {
      return res
        .status(404)
        .json({ success: false, message: 'Student profile not found' });
    }

    const preferredDate = toStartOfDay(date);

    // ✅ Check tutor availability (same logic as student->tutor flow)
    const tutorAvail = Array.isArray(tutorProfile.availability)
      ? tutorProfile.availability
      : [];
    const tutorAvailable = tutorAvail.includes(date);
    if (!tutorAvailable) {
      return res.status(400).json({
        success: false,
        message: 'You are not available on selected date',
      });
    }

    // ✅ Optionally check student availability if they set it
    const studentAvail = Array.isArray(studentProfile.availability)
      ? studentProfile.availability
      : [];
    if (studentAvail.length && !studentAvail.includes(date)) {
      return res.status(400).json({
        success: false,
        message: 'Student not available on selected date',
      });
    }

    // Prevent double booking for same tutor+student+slot
    const existingForSamePair = await Booking.findOne({
      studentId,
      tutorId,
      type: 'demo',
      preferredDate,
      preferredTime: time,
      status: { $ne: 'cancelled' },
    });

    if (existingForSamePair) {
      return res.status(400).json({
        success: false,
        message:
          'You already have a demo request with this student for this time slot.',
      });
    }

    // Prevent double booking of the slot for this tutor
    const existingSlotForTutor = await Booking.findOne({
      tutorId,
      type: 'demo',
      preferredDate,
      preferredTime: time,
      status: { $in: ['pending', 'confirmed'] },
    });

    if (existingSlotForTutor) {
      return res.status(400).json({
        success: false,
        message: 'This time slot is already booked for you.',
      });
    }

    // ✅ Create booking – IMPORTANT mapping
    const booking = await Booking.create({
      studentId,                 // receiver
      tutorId,                   // sender
      subject,
      preferredDate,
      preferredTime: time,
      note: note || '',
      type: 'demo',
      status: 'pending',
      meetingLink: '',
      requestedBy: 'tutor',      // 🔥 NEW
    });

    // Notifications to student + admin
    try {
      const studentUser = await User.findById(studentId).lean();
      const tutorUser = await User.findById(tutorId).lean();

      const tutorName = tutorProfile.name || tutorUser?.phone || 'A tutor';
      const studentEmail = studentProfile.email || studentUser?.email;

      if (studentEmail && notificationService?.sendEmail) {
        const html =
          emailTpl.studentDemoRequestHTML?.({
            tutorName,
            subject,
            date,
            time,
          }) ||
          `<p>${tutorName} has requested a demo for ${subject} on ${date} at ${time}.</p>`;

        await notificationService.sendEmail(
          studentEmail,
          'New Demo Request from Tutor - TuitionTime',
          '',
          html
        );
      }

      if (notificationService?.createInApp) {
        await notificationService.createInApp(
          studentId,
          'New Demo Request',
          `${tutorName} requested a demo for ${subject} on ${date} at ${time}`,
          { tutorId, studentId, subject, date, time, bookingId: booking._id }
        );
      }

      await createAdminNotification(
        'New Tutor-Initiated Demo Booking',
        `${tutorName} requested a demo with ${studentProfile.name || 'Student'
        } for ${subject} on ${date} at ${time}`,
        {
          bookingId: booking._id,
          tutorId,
          studentId,
          subject,
          date,
          time,
          type: booking.type,
          status: booking.status,
          requestedBy: booking.requestedBy,
        }
      );
    } catch (e) {
      console.warn('Notification (student/admin) failed:', e.message);
    }

    return res.status(201).json({ success: true, data: booking });
  } catch (err) {
    console.error('createDemoBookingByTutor error:', err);
    return res.status(500).json({
      success: false,
      message: 'Failed to create demo booking by tutor',
    });
  }
};


exports.getStudentBookings = async (req, res) => {
  try {
    // Read type from query: ?type=demo or ?type=regular
    // If not provided, it will return ALL types.
    const { type } = req.query;

    const filter = {
      studentId: req.user.id,
    };

    // Optional type filter (only allow known values)
    if (type && ['demo', 'regular'].includes(type)) {
      filter.type = type;
    }

    const bookings = await Booking.find(filter)
      .sort({ createdAt: -1 })
      .lean();

    if (!bookings.length) {
      return res.json({ success: true, data: [] });
    }

    const tutorUserIds = [
      ...new Set(
        bookings
          .map((b) => (b.tutorId ? String(b.tutorId) : null))
          .filter(Boolean)
      ),
    ];

    const tutorProfiles = await TutorProfile.find({
      userId: { $in: tutorUserIds },
    })
      .select('userId name')
      .lean();

    const tutorNameByUserId = new Map(
      tutorProfiles.map((tp) => [String(tp.userId), tp.name])
    );

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

    if (booking.tutorId.toString() !== req.user.id) {
      return res
        .status(403)
        .json({ success: false, message: 'Not authorized' });
    }

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
      const displayDate = new Date(booking.preferredDate).toDateString();
      const displayTime = booking.preferredTime || '';

      if (studentUser?.email && notificationService?.sendEmail) {
        const html = emailTpl.bookingConfirmedHTML({
          tutorName,
          subject: booking.subject,
          date: displayDate,
          time: displayTime,
          link: booking.meetingLink,
        });
        await notificationService.sendEmail(
          studentUser.email,
          'Demo Confirmed - TuitionTime',
          '',
          html
        );
      }

      if (tutorUser?.email && notificationService?.sendEmail) {
        const html = emailTpl.bookingConfirmedHTML({
          tutorName,
          subject: booking.subject,
          date: displayDate,
          time: displayTime,
          link: booking.meetingLink,
        });
        await notificationService.sendEmail(
          tutorUser.email,
          'Demo Confirmed - TuitionTime',
          '',
          html
        );
      }

      if (notificationService?.createInApp) {
        await notificationService.createInApp(
          booking.studentId,
          'Demo Confirmed',
          `Your demo with ${tutorName} is confirmed for ${displayDate}${displayTime ? ` at ${displayTime}` : ''
          }.`,
          {
            meetingLink: booking.meetingLink,
            bookingId: booking._id,
          }
        );
      }

      await createAdminNotification(
        'Demo Confirmed',
        `Demo confirmed for ${booking.subject} by ${tutorName} on ${displayDate}${displayTime ? ` at ${displayTime}` : ''
        }`,
        {
          bookingId: booking._id,
          tutorId: booking.tutorId,
          studentId: booking.studentId,
          meetingLink: booking.meetingLink,
          preferredTime: booking.preferredTime,
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

      await createAdminNotification(
        'Demo Cancelled',
        `Demo cancelled for ${booking.subject} by ${tutorName}`,
        {
          bookingId: booking._id,
          tutorId: booking.tutorId,
          studentId: booking.studentId,
          preferredTime: booking.preferredTime,
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
 * ✅ Student confirms/cancels a demo that was requested BY TUTOR
 * PATCH /api/bookings/:id/student-status
 * Body: { status: 'confirmed' | 'cancelled' }
 */
exports.updateDemoStatusByStudent = async (req, res) => {
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

    // Must be tutor-initiated
    if (booking.requestedBy !== 'tutor') {
      return res.status(400).json({
        success: false,
        message: 'This booking is not tutor-initiated',
      });
    }

    // Only the student of this booking can confirm
    if (booking.studentId.toString() !== req.user.id) {
      return res
        .status(403)
        .json({ success: false, message: 'Not authorized' });
    }

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
      const studentProfile = await StudentProfile.findOne({
        userId: booking.studentId,
      }).lean();

      const tutorName = tutorProfile?.name || 'Tutor';
      const studentName = studentProfile?.name || 'Student';
      const displayDate = new Date(booking.preferredDate).toDateString();
      const displayTime = booking.preferredTime || '';

      // Email student
      if (studentUser?.email && notificationService?.sendEmail) {
        const html =
          emailTpl.bookingConfirmedHTML?.({
            tutorName,
            subject: booking.subject,
            date: displayDate,
            time: displayTime,
            link: booking.meetingLink,
          }) ||
          `<p>Your demo with ${tutorName} is confirmed on ${displayDate} at ${displayTime}. Meeting: ${booking.meetingLink}</p>`;

        await notificationService.sendEmail(
          studentUser.email,
          'Demo Confirmed - TuitionTime',
          '',
          html
        );
      }

      // Email tutor
      if (tutorUser?.email && notificationService?.sendEmail) {
        const html =
          emailTpl.bookingConfirmedHTML?.({
            tutorName,
            subject: booking.subject,
            date: displayDate,
            time: displayTime,
            link: booking.meetingLink,
          }) ||
          `<p>Your demo with ${studentName} is confirmed on ${displayDate} at ${displayTime}. Meeting: ${booking.meetingLink}</p>`;

        await notificationService.sendEmail(
          tutorUser.email,
          'Demo Confirmed - TuitionTime',
          '',
          html
        );
      }

      if (notificationService?.createInApp) {
        await notificationService.createInApp(
          booking.tutorId,
          'Demo Confirmed',
          `${studentName} confirmed your demo for ${displayDate}${displayTime ? ` at ${displayTime}` : ''
          }.`,
          {
            meetingLink: booking.meetingLink,
            bookingId: booking._id,
          }
        );
      }

      await createAdminNotification(
        'Tutor-Initiated Demo Confirmed',
        `Demo confirmed for ${booking.subject} between ${tutorName} and ${studentName} on ${displayDate}${displayTime ? ` at ${displayTime}` : ''
        }`,
        {
          bookingId: booking._id,
          tutorId: booking.tutorId,
          studentId: booking.studentId,
          meetingLink: booking.meetingLink,
          preferredTime: booking.preferredTime,
          status: booking.status,
          requestedBy: booking.requestedBy,
        }
      );

      return res.json({
        success: true,
        message: 'Demo confirmed successfully.',
        data: booking,
      });
    }

    // cancelled
    if (status === 'cancelled') {
      booking.status = 'cancelled';
      await booking.save();

      const tutorProfile = await TutorProfile.findOne({
        userId: booking.tutorId,
      }).lean();
      const tutorUser = await User.findById(booking.tutorId);
      const studentProfile = await StudentProfile.findOne({
        userId: booking.studentId,
      }).lean();

      const tutorName = tutorProfile?.name || 'Tutor';
      const studentName = studentProfile?.name || 'Student';

      if (tutorUser?.email && notificationService?.sendEmail) {
        const html =
          emailTpl.bookingCancelledHTML?.({
            tutorName,
            subject: booking.subject,
          }) ||
          `<p>${studentName} cancelled the demo for ${booking.subject}.</p>`;

        await notificationService.sendEmail(
          tutorUser.email,
          'Demo Cancelled - TuitionTime',
          '',
          html
        );
      }

      if (notificationService?.createInApp) {
        await notificationService.createInApp(
          booking.tutorId,
          'Demo Cancelled',
          `${studentName} cancelled your demo request.`,
          { tutorId: booking.tutorId, bookingId: booking._id }
        );
      }

      await createAdminNotification(
        'Tutor-Initiated Demo Cancelled',
        `Demo cancelled for ${booking.subject} by ${studentName}`,
        {
          bookingId: booking._id,
          tutorId: booking.tutorId,
          studentId: booking.studentId,
          preferredTime: booking.preferredTime,
          status: booking.status,
          requestedBy: booking.requestedBy,
        }
      );

      return res.json({
        success: true,
        message: 'Demo cancelled successfully.',
        data: booking,
      });
    }
  } catch (err) {
    console.error('updateDemoStatusByStudent error:', err);
    res.status(500).json({
      success: false,
      message: 'Failed to update booking status',
      error: err.message,
    });
  }
};


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

      await createAdminNotification(
        'New Demo Feedback',
        `Feedback received: ${rating}/5 for ${booking.subject}`,
        {
          bookingId: booking._id,
          tutorId: booking.tutorId,
          studentId: booking.studentId,
          rating,
          feedback,
          preferredTime: booking.preferredTime,
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

// controllers/bookingController.js (add this)
exports.getBookingByIdForAdmin = async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    const { id } = req.params;

    const booking = await Booking.findById(id).lean();
    if (!booking) {
      return res
        .status(404)
        .json({ success: false, message: 'Booking not found' });
    }

    const [studentProfile, tutorProfile] = await Promise.all([
      StudentProfile.findOne({ userId: booking.studentId }).select('name email').lean(),
      TutorProfile.findOne({ userId: booking.tutorId }).select('name email').lean(),
    ]);

    res.json({
      success: true,
      data: {
        ...booking,
        studentName: studentProfile?.name || 'Student',
        studentEmail: studentProfile?.email,
        tutorName: tutorProfile?.name || 'Tutor',
        tutorEmail: tutorProfile?.email,
      },
    });
  } catch (err) {
    console.error('getBookingByIdForAdmin error:', err);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch booking',
    });
  }
};

// Helper: generate sessions for 4 weeks initially
async function generateSessionsForRegularClass(regularClass) {
  const sessions = [];
  const { timeSlots, startDate, studentId, tutorId, _id } = regularClass;

  if (!timeSlots || !timeSlots.length) return;

  const start = new Date(startDate);
  const weeksToGenerate = 4;

  // map dayOfWeek to JS day index
  const dayMap = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };

  for (let w = 0; w < weeksToGenerate; w++) {
    timeSlots.forEach((slot) => {
      const [hourStr, minuteStr] = slot.time.split(":");
      const slotDayIndex = dayMap[slot.dayOfWeek];
      if (slotDayIndex === undefined) return;

      const d = new Date(start);
      // move to that week
      d.setDate(d.getDate() + w * 7);

      const diff = slotDayIndex - d.getDay();
      d.setDate(d.getDate() + diff);

      d.setHours(parseInt(hourStr, 10), parseInt(minuteStr, 10), 0, 0);

      sessions.push({
        regularClassId: _id,
        studentId,
        tutorId,
        startDateTime: d,
        status: "scheduled",
      });
    });
  }

  if (sessions.length) {
    await Session.insertMany(sessions);
  }
}

/**
 * POST /api/bookings/:id/feedback
 * Body: { teaching, communication, understanding, comment, likedTutor }
 */
exports.giveDemoFeedback = async (req, res) => {
  try {
    const bookingId = req.params.id;
    const { teaching, communication, understanding, comment, likedTutor } =
      req.body;
    const userId = req.user.id;

    if (
      !teaching ||
      !communication ||
      !understanding ||
      likedTutor === undefined
    ) {
      return res.status(400).json({
        success: false,
        message:
          'teaching, communication, understanding, likedTutor are required',
      });
    }

    const booking = await Booking.findById(bookingId);
    if (!booking) {
      return res
        .status(404)
        .json({ success: false, message: 'Booking not found' });
    }

    // ✅ Auth: only the booked student can submit feedback
    if (booking.studentId.toString() !== userId) {
      return res
        .status(403)
        .json({ success: false, message: 'Not authorized for this booking' });
    }

    if (booking.type !== 'demo') {
      return res.status(400).json({
        success: false,
        message: 'Only demo bookings can get feedback',
      });
    }

    if (!['confirmed', 'completed'].includes(booking.status)) {
      return res.status(400).json({
        success: false,
        message: 'Feedback allowed only after confirmed/completed demo',
      });
    }

    if (booking.demoFeedback && booking.demoFeedback.createdAt) {
      return res
        .status(400)
        .json({ success: false, message: 'Feedback already submitted' });
    }

    const overall = Math.round(
      (teaching + communication + understanding) / 3
    );

    booking.demoFeedback = {
      teaching,
      communication,
      understanding,
      overall,
      comment: comment || '',
      likedTutor: !!likedTutor,
      createdAt: new Date(),
    };
    booking.status = 'completed';
    await booking.save();

    // update tutor rating (TutorProfile is keyed by userId)
    const tutorProfile = await TutorProfile.findOne({
      userId: booking.tutorId,
    });
    if (tutorProfile) {
      tutorProfile.ratingSum = (tutorProfile.ratingSum || 0) + overall;
      tutorProfile.ratingCount = (tutorProfile.ratingCount || 0) + 1;
      tutorProfile.rating =
        tutorProfile.ratingSum / Math.max(tutorProfile.ratingCount, 1);
      await tutorProfile.save();
    }

    // notify tutor by email
    try {
      const tutorUser = await User.findById(booking.tutorId);
      const studentProfile = await StudentProfile.findOne({
        userId: booking.studentId,
      }).lean();

      const studentName = studentProfile?.name || 'Student';
      const tutorName = tutorProfile?.name || 'Tutor';

      if (tutorUser && notificationService?.sendEmail) {
        const subjectLine = 'New demo feedback received';
        const html =
          emailTpl.demoFeedbackToTutor?.({
            tutorName,
            studentName,
            teaching,
            communication,
            understanding,
            overall,
            comment,
          }) ||
          `<p>You received new demo feedback from ${studentName}. Overall: ${overall}/5</p>`;
        await notificationService.sendEmail(
          tutorUser.email,
          subjectLine,
          '',
          html
        );
      }
    } catch (err) {
      console.error('Error notifying tutor about feedback:', err);
    }

    // notify admin
    await createAdminNotification(
      'Demo feedback submitted',
      `Feedback for demo booking ${booking._id}`,
      {
        bookingId: booking._id,
        tutorId: booking.tutorId,
        studentId: booking.studentId,
        overall,
        likedTutor,
      }
    );

    // ⭐⭐⭐ ADD HOURLY / MONTHLY RATE IN RESPONSE ⭐⭐⭐
    const tutorProfileToReturn = await TutorProfile.findOne({
      userId: booking.tutorId,
    }).select("name hourlyRate monthlyRate photoUrl").lean();

    return res.json({
      success: true,
      message: 'Feedback submitted',
      data: {
        booking,
        tutorName: tutorProfileToReturn?.name || "Tutor",
        tutorRates: {
          hourlyRate: tutorProfileToReturn?.hourlyRate || 0,
          monthlyRate: tutorProfileToReturn?.monthlyRate || 0
        }
      },
    });

  } catch (err) {
    console.error('giveDemoFeedback error:', err);
    return res.status(500).json({
      success: false,
      message: 'Server error',
      error: err.message,
    });
  }
};

exports.startRegularFromDemo = async (req, res) => {
  try {
    const bookingId = req.params.id;
    const {
      planType,
      billingType,     // "hourly" | "monthly"
      numberOfClasses  // required only for hourly
    } = req.body;

    const userId = req.user.id;

    const booking = await Booking.findById(bookingId);

    if (!booking) {
      return res
        .status(404)
        .json({ success: false, message: "Booking not found" });
    }

    // ✅ Only demo bookings can be upgraded
    if (booking.type !== "demo") {
      return res.status(400).json({
        success: false,
        message: "Only demo bookings can be upgraded",
      });
    }

    // ✅ Must have positive feedback / likedTutor = true
    if (!booking.demoFeedback || booking.demoFeedback.likedTutor === false) {
      return res.status(400).json({
        success: false,
        message: "Regular classes allowed only after positive feedback",
      });
    }

    // ✅ Auth: only the student who owns this booking can upgrade
    if (booking.studentId.toString() !== userId) {
      return res.status(403).json({
        success: false,
        message: "You are not allowed to start regular classes for this booking",
      });
    }

    // ✅ Validate billingType
    if (!billingType || !["hourly", "monthly"].includes(billingType)) {
      return res.status(400).json({
        success: false,
        message: "billingType must be 'hourly' or 'monthly'",
      });
    }

    // For hourly billing, we NEED numberOfClasses
    if (billingType === "hourly" && !numberOfClasses) {
      return res.status(400).json({
        success: false,
        message: "numberOfClasses is required when billingType is 'hourly'",
      });
    }

    // planType is more for labeling / future logic, still good to keep
    if (!planType) {
      return res.status(400).json({
        success: false,
        message: "planType is required",
      });
    }

    // ✅ Load tutor profile to read availability + rates
    const tutorProfile = await TutorProfile.findOne({
      userId: booking.tutorId,
    }).lean();

    if (!tutorProfile) {
      return res.status(404).json({
        success: false,
        message: "Tutor profile not found",
      });
    }

    const tutorAvailability = Array.isArray(tutorProfile.availability)
      ? tutorProfile.availability
      : [];

    // 🧠 Derive startDate from tutor availability (first future date)
    const today = new Date();
    const todayStr = today.toISOString().slice(0, 10); // "YYYY-MM-DD"

    const futureDates = tutorAvailability
      .filter((d) => d >= todayStr)
      .sort(); // works for YYYY-MM-DD

    if (!futureDates.length) {
      return res.status(400).json({
        success: false,
        message:
          "Tutor has no upcoming availability. Regular classes cannot be started right now.",
      });
    }

    const startDateStr = futureDates[0]; // earliest available upcoming date
    const startDateObj = toStartOfDay(startDateStr);

    // 💰 Decide base rate based on billingType
    let baseRate = 0;
    if (billingType === "hourly") {
      baseRate = tutorProfile.hourlyRate || 0;
      if (!baseRate) {
        return res.status(400).json({
          success: false,
          message: "Tutor hourlyRate is not set. Cannot create hourly plan.",
        });
      }
    } else if (billingType === "monthly") {
      baseRate = tutorProfile.monthlyRate || 0;
      if (!baseRate) {
        return res.status(400).json({
          success: false,
          message: "Tutor monthlyRate is not set. Cannot create monthly plan.",
        });
      }
    }

    // 💰 Compute total amount
    let totalAmountINR = 0;
    if (billingType === "hourly") {
      // Pay-per-class: hourlyRate * numberOfClasses
      totalAmountINR = baseRate * Number(numberOfClasses);
    } else {
      // Monthly plan: one-month subscription
      // (later we can support multi-month, but keep simple now)
      totalAmountINR = baseRate;
    }

    const amountPaise = Math.round(totalAmountINR * 100);

    // 🔧 Default values for now (since frontend does NOT send these)
    const sessionsPerWeek = 2;  // just informational for now
    const timeSlots = [];       // future: fixed timetable

    // ---------------------------------------------
    // 1️⃣ Create Regular Class (subscription record)
    // ---------------------------------------------
    const rc = await RegularClass.create({
      studentId: booking.studentId,   // User _id (student)
      tutorId: booking.tutorId,       // User _id (tutor)
      subject: booking.subject,
      planType,                       // e.g. "regular", "package"
      sessionsPerWeek,
      timeSlots,

      // Derived from availability
      startDate: startDateObj,

      // Store base unit price in regularClass (helpful for later renewals)
      amount: baseRate,
      currency: "INR",

      paymentStatus: "pending", // becomes "paid" after webhook
      status: "active",

      currentPeriodStart: startDateObj,
      currentPeriodEnd: new Date(
        new Date(startDateObj).setMonth(startDateObj.getMonth() + 1)
      ),
    });

    // Link back to booking (for history)
    booking.regularClassId = rc._id;
    await booking.save();

    // ---------------------------------------------
    // 2️⃣ Create Payment record (before payment)
    // ---------------------------------------------
    const payment = await Payment.create({
      regularClassId: rc._id,
      studentId: booking.studentId,
      tutorId: booking.tutorId,
      type: "subscription",
      amount: totalAmountINR,      // total amount to be paid NOW
      currency: "INR",
      gateway: "razorpay",
      status: "created",
      notes: `BillingType=${billingType}, Classes=${numberOfClasses || ""}, StartDate=${startDateStr}`,
    });

    // ---------------------------------------------
    // 3️⃣ Razorpay Order Creation
    // ---------------------------------------------
    const razorpay = require("../services/payments/razorpay");

    const order = await razorpay.orders.create({
      amount: amountPaise,
      currency: "INR",
      receipt: "rc_" + rc._id + "_" + Date.now(),
      notes: {
        regularClassId: rc._id.toString(),
        bookingId: booking._id.toString(),
        numberOfClasses: numberOfClasses ? String(numberOfClasses) : "",
        billingType,
        startDate: startDateStr,
      },
    });

    // Save order id in payment
    payment.gatewayOrderId = order.id;
    await payment.save();

    // ---------------------------------------------
    // 4️⃣ Notify Admin
    // ---------------------------------------------
    await createAdminNotification(
      "Regular Classes Started (Pending Payment)",
      `Student is about to pay for regular class ${rc._id}`,
      {
        bookingId: booking._id,
        regularClassId: rc._id,
        paymentId: payment._id,
        billingType,
        numberOfClasses,
        baseRate,
        amountToPay: totalAmountINR,
        startDate: startDateStr,
      }
    );

    // ---------------------------------------------
    // 5️⃣ Return payment details to frontend
    // ---------------------------------------------
    return res.json({
      success: true,
      message: "Regular class created. Proceed to payment.",
      data: {
        regularClassId: rc._id,
        paymentId: payment._id,
        razorpayKey: process.env.RAZORPAY_KEY_ID,
        orderId: order.id,
        amount: amountPaise,
        currency: "INR",
        startDate: startDateStr,
        billingType,
        baseRate,
        totalAmountINR,
      },
    });
  } catch (err) {
    console.error("startRegularFromDemo error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error",
      error: err.message,
    });
  }
};

// Tutor creates a REGULAR class instance for a student
// POST /api/bookings/regular
// Body: { regularClassId, date, time, note }
exports.createRegularBooking = async (req, res) => {
  try {
    const { regularClassId, date, time, note } = req.body;
    const tutorId = req.user.id; // logged-in tutor

    if (!regularClassId || !date || !time) {
      return res.status(400).json({
        success: false,
        message: "regularClassId, date and time are required",
      });
    }

    // 1️⃣ Find the regular class (subscription)
    const regularClass = await RegularClass.findById(regularClassId).lean();
    if (!regularClass) {
      return res.status(404).json({
        success: false,
        message: "Regular class not found",
      });
    }

    // 2️⃣ Ensure this tutor owns that regular class
    if (String(regularClass.tutorId) !== String(tutorId)) {
      return res.status(403).json({
        success: false,
        message: "You are not allowed to create bookings for this class",
      });
    }

    // 3️⃣ Optional: ensure regular class is active
    if (regularClass.status && regularClass.status !== "active") {
      return res.status(400).json({
        success: false,
        message: "Regular class is not active",
      });
    }

    // 4️⃣ Load tutor profile to read availability
    const tutorProfile = await TutorProfile.findOne({
      userId: regularClass.tutorId,
    }).lean();

    if (!tutorProfile) {
      return res.status(404).json({
        success: false,
        message: "Tutor profile not found",
      });
    }

    const avail = Array.isArray(tutorProfile.availability)
      ? tutorProfile.availability
      : [];

    // Date MUST be from tutor availability (like createDemoBooking)
    const isAvailable = avail.includes(date);
    if (!isAvailable) {
      return res.status(400).json({
        success: false,
        message: "Tutor not available on selected date",
      });
    }

    const preferredDate = toStartOfDay(date);

    // 5️⃣ Calculate end time = start time + 60 minutes
    const endTime = addMinutesToTime(time, 60); // 1 hour class

    // 6️⃣ Prevent double booking same student/tutor/date/time/type=regular
    const existing = await Booking.findOne({
      studentId: regularClass.studentId,
      tutorId: regularClass.tutorId,
      type: "regular",
      preferredDate,
      preferredTime: time,
      status: { $ne: "cancelled" },
    });

    if (existing) {
      return res.status(400).json({
        success: false,
        message:
          "A regular class is already scheduled for this date and time for this student.",
      });
    }

    // 7️⃣ Create booking record of type "regular"
    const meetingLink = `https://meet.jit.si/tuitiontime-regular-${Date.now()}`;

    const booking = await Booking.create({
      studentId: regularClass.studentId,
      tutorId: regularClass.tutorId,
      subject: regularClass.subject,
      preferredDate,
      preferredTime: time,       // start time
      preferredEndTime: endTime, // 👈 NEW: end time (1hr later)
      note: note || "",
      type: "regular",
      status: "scheduled",       // regular class is already fixed
      meetingLink,
      regularClassId: regularClass._id,
    });

    // 8️⃣ Notify student
    try {
      const studentUser = await User.findById(regularClass.studentId).lean();
      const tutorNameProfile = await TutorProfile.findOne({
        userId: regularClass.tutorId,
      }).lean();

      const tutorName = tutorNameProfile?.name || "Your Tutor";
      const displayDate = new Date(preferredDate).toDateString();
      const displayStartTime = time;
      const displayEndTime = endTime;

      if (studentUser?.email && notificationService?.sendEmail) {
        const html =
          emailTpl.regularClassScheduledHTML?.({
            tutorName,
            subject: regularClass.subject,
            date: displayDate,
            startTime: displayStartTime,
            endTime: displayEndTime,
            link: meetingLink,
          }) ||
          `<p>Your regular class with ${tutorName} is scheduled on ${displayDate} from ${displayStartTime} to ${displayEndTime}. Meeting link: ${meetingLink}</p>`;

        await notificationService.sendEmail(
          studentUser.email,
          "Regular Class Scheduled - TuitionTime",
          "",
          html
        );
      }

      if (notificationService?.createInApp) {
        await notificationService.createInApp(
          regularClass.studentId,
          "Regular Class Scheduled",
          `Your regular class with ${tutorName} is scheduled on ${displayDate} from ${displayStartTime} to ${displayEndTime}.`,
          {
            bookingId: booking._id,
            regularClassId: regularClass._id,
            meetingLink,
          }
        );
      }

      await createAdminNotification(
        "Regular Class Booking Created",
        `New regular class created for subject ${regularClass.subject}`,
        {
          bookingId: booking._id,
          regularClassId: regularClass._id,
          tutorId: regularClass.tutorId,
          studentId: regularClass.studentId,
          date,
          startTime: time,
          endTime,
          type: "regular",
          status: booking.status,
        }
      );
    } catch (notifyErr) {
      console.warn("Regular booking notification failed:", notifyErr.message);
    }

    return res.status(201).json({
      success: true,
      message: "Regular class booking created successfully.",
      data: booking,
    });
  } catch (err) {
    console.error("createRegularBooking error:", err);
    return res.status(500).json({
      success: false,
      message: "Failed to create regular booking",
      error: err.message,
    });
  }
};
