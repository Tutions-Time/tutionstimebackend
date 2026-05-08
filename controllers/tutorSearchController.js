const TutorProfile = require('../models/TutorProfile');
const Session = require('../models/Session');
const Booking = require('../models/Booking');
const StudentProfile = require('../models/StudentProfile');
const User = require('../models/User');
const { buildTutorFilter, getRecommendedTutors } = require('../services/tutorService');

async function gatherTutorReviews(tutorProfileId, tutorUserId) {
  if (!tutorProfileId) return [];

  const sessionFeedbacks = await Session.find({
    tutorId: tutorProfileId,
    sessionFeedback: { $exists: true, $ne: null },
  })
    .select('sessionFeedback studentId startDateTime')
    .populate('studentId', 'name')
    .sort({ 'sessionFeedback.createdAt': -1 })
    .limit(10)
    .lean();

  const demoFeedbacks = tutorUserId
    ? await Booking.find({
        tutorId: tutorUserId,
        demoFeedback: { $exists: true, $ne: null },
      })
        .select('demoFeedback studentId createdAt')
        .sort({ 'demoFeedback.createdAt': -1 })
        .limit(10)
        .lean()
    : [];

  const studentUserIds = [
    ...new Set(
      demoFeedbacks
        .map((b) => b.studentId)
        .filter((id) => !!id)
        .map((id) => String(id))
    ),
  ];

  const studentProfiles =
    studentUserIds.length > 0
      ? await StudentProfile.find({ userId: { $in: studentUserIds } })
          .select('userId name')
          .lean()
      : [];

  const profileByUserId = new Map(
    studentProfiles.map((p) => [String(p.userId), p.name || 'Student'])
  );

  const formatSessionReview = (session) => ({
    rating: session.sessionFeedback?.overall ?? null,
    teaching: session.sessionFeedback?.teaching ?? null,
    communication: session.sessionFeedback?.communication ?? null,
    understanding: session.sessionFeedback?.understanding ?? null,
    comment: session.sessionFeedback?.comment || '',
    studentName: session.studentId?.name || 'Student',
    createdAt: session.sessionFeedback?.createdAt || session.startDateTime,
    source: 'ok-session',
  });

  const formatDemoReview = (booking) => ({
    rating: booking.demoFeedback?.overall ?? null,
    teaching: booking.demoFeedback?.teaching ?? null,
    communication: booking.demoFeedback?.communication ?? null,
    understanding: booking.demoFeedback?.understanding ?? null,
    comment: booking.demoFeedback?.comment || '',
    studentName: profileByUserId.get(String(booking.studentId)) || 'Student',
    createdAt: booking.demoFeedback?.createdAt || booking.createdAt,
    source: 'demo',
  });

  const combined = [
    ...sessionFeedbacks.map(formatSessionReview),
    ...demoFeedbacks.map(formatDemoReview),
  ].filter((review) => review.rating !== null);

  combined.sort((a, b) => {
    const da = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const db = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return db - da;
  });

  return combined.slice(0, 6);
}

/**
 * GET /api/tutors/search
 * Supports filters: city, subject, classLevel, board, gender, teachingMode,
 * minExp, maxExp, minRate, maxRate, sort, pagination (page, limit)
 */
exports.searchTutors = async (req, res) => {
  try {
    const hasFilters = Object.keys(req.query).length > 0;

    if (hasFilters) {
      // 🧩 Build query filter
      const filter = await buildTutorFilter(req.query, {
        studentId: req.user?.role === "student" ? req.user.id : null,
      });

      // Sorting
      const sortParam = req.query.sort || 'createdAt_desc';
      let sort = {};
      const [field, order] = sortParam.split('_');
      const validSorts = ['createdAt', 'experience', 'hourlyRate', 'lastLogin', 'isFeatured'];
      if (validSorts.includes(field)) {
        sort[field] = order === 'asc' ? 1 : -1;
      } else {
        sort['createdAt'] = -1;
      }

      const activeTutorUsers = await User.find({
        role: 'tutor',
        status: { $ne: 'suspended' },
      })
        .select('_id')
        .lean();

      const activeTutorUserIds = activeTutorUsers.map((u) => u._id);
      filter.userId = { $in: activeTutorUserIds };

      // Pagination
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 20;
      const skip = (page - 1) * limit;
      const totalMatches = await TutorProfile.countDocuments(filter);

      // Fetch tutors
      const tutors = await TutorProfile.find(filter)
        .populate('userId', 'phone role lastLogin status isProfileComplete')
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .select(
          'name photoUrl city pincode qualification specialization experience hourlyRate monthlyRate gender subjects addressLine1 lastLogin rating isFeatured availability kycStatus'
        )
        .lean();

      const activeTutors = tutors.map((t) => ({
        ...t,
        isVerifiedTutor:
          Boolean(t?.userId?.isProfileComplete) &&
          String(t?.kycStatus || '').toLowerCase() === 'approved',
      }));

      return res.status(200).json({
        success: true,
        mode: 'filter',
        page,
        total: totalMatches,
        count: activeTutors.length,
        data: activeTutors,
      });
    }

    // 🧠 No filters → Use AI recommendation logic
    const studentId = req.user?.id || null;
    const recommended = await getRecommendedTutors(studentId);
    const userIds = recommended
      .map((t) => String(t?.userId || ''))
      .filter(Boolean);
    const users = userIds.length
      ? await User.find({ _id: { $in: userIds } })
          .select('_id isProfileComplete')
          .lean()
      : [];
    const userMap = new Map(users.map((u) => [String(u._id), u]));
    const enrichedRecommended = recommended.map((t) => {
      const u = userMap.get(String(t?.userId || ''));
      return {
        ...t,
        isVerifiedTutor:
          Boolean(u?.isProfileComplete) &&
          String(t?.kycStatus || '').toLowerCase() === 'approved',
      };
    });

    return res.status(200).json({
      success: true,
      mode: 'ai',
      count: enrichedRecommended.length,
      data: enrichedRecommended,
    });
  } catch (error) {
    console.error('Search Tutors Error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message,
    });
  }
};

/**
 * GET /api/tutors/:id
 * Fetch single tutor profile
 */
exports.getTutorById = async (req, res) => {
  try {
    const { id } = req.params;
  const tutor = await TutorProfile.findById(id)
    .populate('userId', 'phone role email status isProfileComplete')
    .lean();

  if (!tutor) {
    return res.status(404).json({
      success: false,
      message: 'Tutor not found',
    });
  }

  const userStatus = String(tutor?.userId?.status || '').toLowerCase();
  if (userStatus === 'suspended') {
    return res.status(404).json({
      success: false,
      message: 'Tutor not found',
    });
  }

  const reviews = await gatherTutorReviews(tutor._id, tutor.userId);

  res.status(200).json({
    success: true,
    data: {
      ...tutor,
      isVerifiedTutor:
        Boolean(tutor?.userId?.isProfileComplete) &&
        String(tutor?.kycStatus || '').toLowerCase() === 'approved',
      reviews,
    },
  });
  } catch (error) {
    console.error('Error fetching tutor profile:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch tutor profile',
      error: error.message,
    });
  }
};
