const Booking = require('../models/Booking');
const TutorProfile = require('../models/TutorProfile');
const StudentProfile = require('../models/StudentProfile');
const User = require('../models/User');
const notificationService = require('../services/notificationService');
const emailTpl = require('../templates/emailTemplates');
const AdminNotification = require('../models/AdminNotification');

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || null;

function toStartOfDay(dateStr) {
  const d = new Date(dateStr);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
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
        `${student?.name || 'A student'} requested a demo with ${
          tutorProfile?.name || 'Tutor'
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

exports.getStudentBookings = async (req, res) => {
  try {
    const bookings = await Booking.find({ studentId: req.user.id })
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
          `Your demo with ${tutorName} is confirmed for ${displayDate}${
            displayTime ? ` at ${displayTime}` : ''
          }.`,
          {
            meetingLink: booking.meetingLink,
            bookingId: booking._id,
          }
        );
      }

      await createAdminNotification(
        'Demo Confirmed',
        `Demo confirmed for ${booking.subject} by ${tutorName} on ${displayDate}${
          displayTime ? ` at ${displayTime}` : ''
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
