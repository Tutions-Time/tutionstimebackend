const SuspensionAppeal = require('../models/SuspensionAppeal');
const User = require('../models/User');
const StudentProfile = require('../models/StudentProfile');
const TutorProfile = require('../models/TutorProfile');
const notificationService = require('../services/notificationService');
const { createAdminNotification } = require('../services/adminNotification');
const emailTemplates = require('../templates/emailTemplates');

const APP_URL = (process.env.FRONTEND_URL || process.env.CLIENT_URL || 'http://localhost:3000').replace(/\/$/, '');

async function getProfileForUser(user) {
  if (user.role === 'student') return StudentProfile.findOne({ userId: user._id }).lean();
  if (user.role === 'tutor') return TutorProfile.findOne({ userId: user._id }).lean();
  return null;
}

function replyRouteFor(role, id) {
  return role === 'tutor'
    ? `/dashboard/tutor/suspension/${id}`
    : `/dashboard/student/suspension/${id}`;
}

exports.createSuspensionCaseAndNotify = async ({ req, user, reason, explanation }) => {
  const cleanReason = String(reason || '').trim();
  const cleanExplanation = String(explanation || '').trim();
  if (!cleanReason) {
    const err = new Error('Suspension reason is required.');
    err.statusCode = 400;
    throw err;
  }

  const appeal = await SuspensionAppeal.create({
    userId: user._id,
    role: user.role,
    reason: cleanReason,
    explanation: cleanExplanation,
    adminId: req?.user?.id,
  });

  const route = replyRouteFor(user.role, appeal._id);
  const profile = await getProfileForUser(user);
  const name = profile?.name || user.email || user.role;
  const email = profile?.email || user.email;
  const body = cleanExplanation
    ? `Reason: ${cleanReason}. Admin message: ${cleanExplanation}`
    : `Reason: ${cleanReason}`;

  try {
    await notificationService.createInApp(user._id, 'Account suspended', body, {
      type: 'account_suspension',
      suspensionAppealId: appeal._id,
      reason: cleanReason,
      explanation: cleanExplanation,
      route,
    });
  } catch (err) {
    console.warn('Suspension in-app notification failed:', err.message);
  }

  if (email) {
    try {
      await notificationService.sendEmail(
        email,
        'Your tuitionstime account has been suspended',
        `Hi ${name}, your tuitionstime account has been suspended. ${body}`,
        emailTemplates.suspensionNoticeHTML({
          name,
          role: user.role,
          reason: cleanReason,
          explanation: cleanExplanation,
          replyLink: `${APP_URL}${route}`,
        })
      );
    } catch (err) {
      console.warn('Suspension email failed:', err.message);
    }
  }

  return appeal;
};

exports.getMySuspensionAppeal = async (req, res) => {
  try {
    const appeal = await SuspensionAppeal.findOne({ _id: req.params.id, userId: req.user.id }).lean();
    if (!appeal) return res.status(404).json({ success: false, message: 'Suspension case not found' });
    res.status(200).json({ success: true, data: appeal });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch suspension case' });
  }
};

exports.replyToSuspensionAppeal = async (req, res) => {
  try {
    const reply = String(req.body.reply || '').trim();
    if (reply.length < 10) {
      return res.status(400).json({ success: false, message: 'Please enter a reply of at least 10 characters.' });
    }

    const appeal = await SuspensionAppeal.findOne({ _id: req.params.id, userId: req.user.id });
    if (!appeal) return res.status(404).json({ success: false, message: 'Suspension case not found' });

    appeal.userReply = reply;
    appeal.repliedAt = new Date();
    appeal.status = 'replied';
    await appeal.save();

    const user = await User.findById(req.user.id).lean();
    const profile = user ? await getProfileForUser(user) : null;
    const name = profile?.name || user?.email || appeal.role;

    await createAdminNotification(
      'Suspension Reply Received',
      `${name} replied to an account suspension notice.`,
      {
        type: 'suspension_reply',
        suspensionAppealId: appeal._id,
        userId: appeal.userId,
        role: appeal.role,
        route: `/dashboard/admin/suspensions/${appeal._id}`,
      }
    );

    res.status(200).json({ success: true, message: 'Your reply has been sent to admin.', data: appeal });
  } catch (err) {
    console.error('Suspension reply error:', err);
    res.status(500).json({ success: false, message: 'Failed to submit reply' });
  }
};

exports.getAdminSuspensionAppeal = async (req, res) => {
  try {
    const appeal = await SuspensionAppeal.findById(req.params.id).lean();
    if (!appeal) return res.status(404).json({ success: false, message: 'Suspension case not found' });
    res.status(200).json({ success: true, data: appeal });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch suspension case' });
  }
};

