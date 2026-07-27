const nodeCron = require('node-cron');
const Session = require('../../models/Session');
const StudentProfile = require('../../models/StudentProfile');
const TutorProfile = require('../../models/TutorProfile');
const Notification = require('../../models/Notification');
const notificationService = require('../notificationService');
const emailTpl = require('../../templates/emailTemplates');

function minutesFromNow(mins) {
  return new Date(Date.now() + mins * 60 * 1000);
}

function formatDate(value) {
  return new Date(value).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'Asia/Kolkata',
  });
}

function formatTime(value) {
  return new Date(value).toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
    timeZone: 'Asia/Kolkata',
  }).toUpperCase();
}

function meetingLinkFor(session, role) {
  if (role === 'tutor') return session.startUrl || session.meetingLink || session.joinUrl || '';
  return session.joinUrl || session.meetingLink || '';
}

function reminderEmailMeta(session, { recipientName, role, subject, classType }) {
  const link = meetingLinkFor(session, role);
  return {
    emailSubject: `${classType} Reminder - tuitionstime`,
    emailText: `${classType} starts soon. ${link ? `Meeting link: ${link}` : 'Open your dashboard for meeting details.'}`,
    emailHtml: emailTpl.sessionReminderHTML({
      recipientName,
      role,
      subject,
      classType,
      date: formatDate(session.startDateTime),
      time: formatTime(session.startDateTime),
      link,
    }),
    meetingLink: link,
  };
}

async function runOnce() {
  const now = new Date();
  const windowStart = minutesFromNow(0);
  const windowEnd = minutesFromNow(60);
  const upcoming = await Session.find({ status: 'scheduled', startDateTime: { $gte: windowStart, $lte: windowEnd } }).limit(200).lean();
  for (const s of upcoming) {
    const tutor = await TutorProfile.findById(s.tutorId).select('userId name').lean();
    const student = s.studentId ? await StudentProfile.findById(s.studentId).select('userId name').lean() : null;
    let subject = 'your class';
    let classType = 'Session';
    if (s.groupBatchId) {
      const GroupBatch = require('../../models/GroupBatch');
      const gb = await GroupBatch.findById(s.groupBatchId).select('subject enrolled').lean();
      subject = gb?.subject || subject;
      classType = 'Group Class';
      s._groupBatch = gb;
    } else if (s.regularClassId) {
      const RegularClass = require('../../models/RegularClass');
      const rc = await RegularClass.findById(s.regularClassId).select('subject').lean();
      subject = rc?.subject || subject;
      classType = 'Regular Class';
    }
    const existsTutor = await Notification.findOne({ userId: tutor?.userId, 'meta.sessionId': s._id, 'meta.tag': 'session_reminder' }).lean();
    if (!existsTutor && tutor?.userId) {
      await notificationService.notifyUser(tutor.userId, 'Upcoming Session', 'Your session starts soon', {
        sessionId: s._id,
        regularClassId: s.regularClassId,
        groupBatchId: s.groupBatchId,
        tag: 'session_reminder',
        startDateTime: s.startDateTime,
        ...reminderEmailMeta(s, {
          recipientName: tutor.name,
          role: 'tutor',
          subject,
          classType,
        }),
      });
    }

    // Handle Group Batches
    if (s.groupBatchId) {
      const GroupBatch = require('../../models/GroupBatch');
      const gb = s._groupBatch || await GroupBatch.findById(s.groupBatchId).select('enrolled subject').lean();
      if (gb && gb.enrolled && gb.enrolled.length > 0) {
         // Notify all enrolled students
         const students = await StudentProfile.find({ _id: { $in: gb.enrolled } }).select('userId name');
         for (const stu of students) {
            const existsStu = await Notification.findOne({ userId: stu.userId, 'meta.sessionId': s._id, 'meta.tag': 'session_reminder' }).lean();
            if (!existsStu) {
                await notificationService.notifyUser(stu.userId, `Upcoming Class: ${gb.subject}`, 'Your group class starts soon', {
                  sessionId: s._id,
                  groupBatchId: s.groupBatchId,
                  tag: 'session_reminder',
                  startDateTime: s.startDateTime,
                  ...reminderEmailMeta(s, {
                    recipientName: stu.name,
                    role: 'student',
                    subject: gb.subject || subject,
                    classType: 'Group Class',
                  }),
                });
            }
         }
      }
    } else if (student?.userId) {
      const existsStu = await Notification.findOne({ userId: student.userId, 'meta.sessionId': s._id, 'meta.tag': 'session_reminder' }).lean();
      if (!existsStu) {
        await notificationService.notifyUser(student.userId, 'Upcoming Session', 'Your session starts soon', {
          sessionId: s._id,
          regularClassId: s.regularClassId,
          tag: 'session_reminder',
          startDateTime: s.startDateTime,
          ...reminderEmailMeta(s, {
            recipientName: student.name,
            role: 'student',
            subject,
            classType,
          }),
        });
      }
    }
  }
}

function start() {
  nodeCron.schedule('*/15 * * * *', runOnce);
}

module.exports = { start, runOnce };

