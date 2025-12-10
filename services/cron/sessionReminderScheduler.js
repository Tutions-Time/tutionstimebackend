const nodeCron = require('node-cron');
const Session = require('../../models/Session');
const StudentProfile = require('../../models/StudentProfile');
const TutorProfile = require('../../models/TutorProfile');
const Notification = require('../../models/Notification');
const notificationService = require('../notificationService');

function minutesFromNow(mins) {
  return new Date(Date.now() + mins * 60 * 1000);
}

async function runOnce() {
  const now = new Date();
  const windowStart = minutesFromNow(0);
  const windowEnd = minutesFromNow(60);
  const upcoming = await Session.find({ status: 'scheduled', startDateTime: { $gte: windowStart, $lte: windowEnd } }).limit(200).lean();
  for (const s of upcoming) {
    const tutor = await TutorProfile.findById(s.tutorId).select('userId name').lean();
    const student = s.studentId ? await StudentProfile.findById(s.studentId).select('userId name').lean() : null;
    const existsTutor = await Notification.findOne({ userId: tutor?.userId, 'meta.sessionId': s._id, 'meta.tag': 'session_reminder' }).lean();
    if (!existsTutor && tutor?.userId) {
      await notificationService.notifyUser(tutor.userId, 'Upcoming Session', 'Your session starts soon', { sessionId: s._id, tag: 'session_reminder', startDateTime: s.startDateTime });
    }
    if (student?.userId) {
      const existsStu = await Notification.findOne({ userId: student.userId, 'meta.sessionId': s._id, 'meta.tag': 'session_reminder' }).lean();
      if (!existsStu) {
        await notificationService.notifyUser(student.userId, 'Upcoming Session', 'Your session starts soon', { sessionId: s._id, tag: 'session_reminder', startDateTime: s.startDateTime });
      }
    }
  }
}

function start() {
  nodeCron.schedule('*/15 * * * *', runOnce);
}

module.exports = { start, runOnce };

