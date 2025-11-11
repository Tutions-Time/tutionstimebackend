// cron/cleanupDemos.js
const mongoose = require('mongoose');
const Booking = require('../models/Booking');
const TutorProfile = require('../models/TutorProfile');
const StudentProfile = require('../models/StudentProfile');
const notificationService = require('../services/notificationService');

require('dotenv').config();
mongoose.connect(process.env.MONGO_URI);

(async () => {
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const stale = await Booking.find({
      status: 'pending',
      createdAt: { $lte: sevenDaysAgo },
    });

    console.log(`🧹 Found ${stale.length} stale demo bookings`);

    for (const b of stale) {
      b.status = 'cancelled';
      await b.save();

      try {
        const tutor = await TutorProfile.findOne({ userId: b.tutorId }).lean();
        const student = await StudentProfile.findOne({ userId: b.studentId }).lean();

        if (student?.email) {
          await notificationService.sendEmail(
            student.email,
            'Demo Request Expired',
            `Your demo request with ${tutor?.name || 'the tutor'} expired automatically.`
          );
        }
        if (tutor?.email) {
          await notificationService.sendEmail(
            tutor.email,
            'Pending Demo Auto-Cancelled',
            `The pending demo request from ${student?.name || 'a student'} has been auto-cancelled after 7 days.`
          );
        }
      } catch (notifyErr) {
        console.warn('Notification failed:', notifyErr.message);
      }
    }

    console.log('✅ Cleanup complete');
  } catch (err) {
    console.error('❌ Cleanup failed:', err);
  } finally {
    await mongoose.disconnect();
  }
})();
