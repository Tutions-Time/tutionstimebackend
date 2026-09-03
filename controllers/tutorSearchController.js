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
    source: 'session',
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

const weightedRating = (average, count) => {
  const globalAverage = 4.2;
  const minimumReviews = 5;
  return (count / (count + minimumReviews)) * average +
    (minimumReviews / (count + minimumReviews)) * globalAverage;
};

const sanitizeTutorCard = (tutor, metrics) => ({
  _id: tutor._id,
  userId: tutor.userId
    ? {
        _id: tutor.userId._id,
        role: tutor.userId.role,
        status: tutor.userId.status,
        isProfileComplete: tutor.userId.isProfileComplete,
      }
    : tutor.userId,
  name: tutor.name,
  photoUrl: tutor.photoUrl,
  city: tutor.city,
  state: tutor.state,
  qualification: tutor.qualification,
  specialization: tutor.specialization,
  experience: tutor.experience,
  hourlyRate: tutor.hourlyRate,
  monthlyRate: tutor.monthlyRate,
  subjects: tutor.subjects || [],
  classLevels: tutor.classLevels || [],
  teachingMode: tutor.teachingMode,
  availability: tutor.availability || [],
  rating: Number(metrics.averageRating.toFixed(1)),
  ratingCount: metrics.reviewCount,
  completedClassesCount: metrics.completedClassesCount,
  completedDemoCount: metrics.completedDemoCount,
  topTutorScore: Number(metrics.score.toFixed(2)),
  isFeatured: tutor.isFeatured,
  isVerifiedTutor:
    Boolean(tutor?.userId?.isProfileComplete) &&
    String(tutor?.kycStatus || '').toLowerCase() === 'approved',
});

/**
 * GET /api/tutors/top
 * Public top tutor ranking based on ratings, reviews, completed classes,
 * completed demos, profile completion, and KYC verification.
 */
exports.getTopTutors = async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 10, 10);

    const tutors = await TutorProfile.find({ name: { $exists: true, $ne: '' } })
      .populate('userId', 'role status isDeleted isProfileComplete')
      .select(
        'name photoUrl city state qualification specialization experience hourlyRate monthlyRate subjects classLevels teachingMode availability rating ratingCount isFeatured kycStatus userId createdAt'
      )
      .lean();

    const activeTutors = tutors.filter((tutor) => {
      const user = tutor.userId;
      return (
        user &&
        user.role === 'tutor' &&
        user.status !== 'suspended' &&
        user.status !== 'inactive' &&
        !user.isDeleted
      );
    });

    const tutorProfileIds = activeTutors.map((tutor) => tutor._id);
    const tutorUserIds = activeTutors
      .map((tutor) => tutor.userId?._id)
      .filter(Boolean);

    const [sessionStats, demoStats] = await Promise.all([
      Session.aggregate([
        { $match: { tutorId: { $in: tutorProfileIds }, status: 'completed' } },
        {
          $group: {
            _id: '$tutorId',
            completedClassesCount: { $sum: 1 },
            sessionReviewCount: {
              $sum: { $cond: [{ $ifNull: ['$sessionFeedback.overall', false] }, 1, 0] },
            },
            sessionRatingSum: { $sum: { $ifNull: ['$sessionFeedback.overall', 0] } },
          },
        },
      ]),
      Booking.aggregate([
        { $match: { tutorId: { $in: tutorUserIds }, status: 'completed' } },
        {
          $group: {
            _id: '$tutorId',
            completedDemoCount: { $sum: 1 },
            demoReviewCount: {
              $sum: { $cond: [{ $ifNull: ['$demoFeedback.overall', false] }, 1, 0] },
            },
            demoRatingSum: { $sum: { $ifNull: ['$demoFeedback.overall', 0] } },
          },
        },
      ]),
    ]);

    const sessionStatsByTutorId = new Map(
      sessionStats.map((item) => [String(item._id), item])
    );
    const demoStatsByTutorUserId = new Map(
      demoStats.map((item) => [String(item._id), item])
    );

    const ranked = activeTutors
      .map((tutor) => {
        const session = sessionStatsByTutorId.get(String(tutor._id)) || {};
        const demo = demoStatsByTutorUserId.get(String(tutor.userId?._id)) || {};
        const profileRatingCount = Number(tutor.ratingCount || 0);
        const profileRating = Number(tutor.rating || 0);
        const calculatedReviewCount =
          Number(session.sessionReviewCount || 0) + Number(demo.demoReviewCount || 0);
        const calculatedRatingSum =
          Number(session.sessionRatingSum || 0) + Number(demo.demoRatingSum || 0);
        const reviewCount = Math.max(profileRatingCount, calculatedReviewCount);
        const averageRating =
          calculatedReviewCount > 0
            ? calculatedRatingSum / calculatedReviewCount
            : profileRating > 0
              ? profileRating
              : 0;
        const completedClassesCount = Number(session.completedClassesCount || 0);
        const completedDemoCount = Number(demo.completedDemoCount || 0);
        const verificationBonus =
          Boolean(tutor?.userId?.isProfileComplete) &&
          String(tutor?.kycStatus || '').toLowerCase() === 'approved'
            ? 8
            : 0;
        const featuredBonus = tutor.isFeatured ? 3 : 0;

        const ratingScore = reviewCount > 0 ? weightedRating(averageRating || 0, reviewCount) * 18 : 0;
        const score =
          ratingScore +
          Math.log1p(reviewCount) * 12 +
          Math.log1p(completedClassesCount) * 10 +
          Math.log1p(completedDemoCount) * 4 +
          verificationBonus +
          featuredBonus;

        return sanitizeTutorCard(tutor, {
          averageRating,
          reviewCount,
          completedClassesCount,
          completedDemoCount,
          score,
        });
      })
      .sort((a, b) => b.topTutorScore - a.topTutorScore)
      .slice(0, limit);

    res.status(200).json({
      success: true,
      count: ranked.length,
      data: ranked,
    });
  } catch (error) {
    console.error('Top Tutors Error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch top tutors',
      error: error.message,
    });
  }
};

/**
 * GET /api/tutors/search
 * Supports filters: city, subject, classLevel, board, gender, teachingMode,
 * minExp, maxExp, minRate, maxRate, sort, pagination (page, limit)
 */
exports.searchTutors = async (req, res) => {
  try {
    const hasFilters = Object.keys(req.query).length > 0;

    if (hasFilters) {
      const filter = await buildTutorFilter(req.query, {
        studentId: req.user?.role === 'student' ? req.user.id : null,
      });

      const sortParam = req.query.sort || 'createdAt_desc';
      let sort = {};
      const [field, order] = sortParam.split('_');
      const validSorts = ['createdAt', 'experience', 'hourlyRate', 'lastLogin', 'isFeatured'];
      if (validSorts.includes(field)) {
        sort[field] = order === 'asc' ? 1 : -1;
      } else {
        sort.createdAt = -1;
      }

      const activeTutorUsers = await User.find({
        role: 'tutor',
        status: { $ne: 'suspended' },
      })
        .select('_id')
        .lean();

      const activeTutorUserIds = activeTutorUsers.map((u) => u._id);
      filter.userId = { $in: activeTutorUserIds };

      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 20;
      const skip = (page - 1) * limit;
      const totalMatches = await TutorProfile.countDocuments(filter);

      const tutors = await TutorProfile.find(filter)
        .populate('userId', 'role lastLogin status isProfileComplete')
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .select(
          'name photoUrl city state qualification specialization experience hourlyRate monthlyRate gender subjects teachingMode lastLogin rating isFeatured availability kycStatus'
        )
        .lean();

      const activeTutors = tutors.map((t) => ({
        ...t,
        pincode: undefined,
        addressLine1: undefined,
        addressLine2: undefined,
        email: undefined,
        altPhone: undefined,
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
        pincode: undefined,
        addressLine1: undefined,
        addressLine2: undefined,
        email: undefined,
        altPhone: undefined,
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
      .populate('userId', 'role status isProfileComplete')
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
    const safeTutor = {
      _id: tutor._id,
      userId: tutor.userId
        ? {
            _id: tutor.userId._id,
            role: tutor.userId.role,
            status: tutor.userId.status,
            isProfileComplete: tutor.userId.isProfileComplete,
          }
        : tutor.userId,
      name: tutor.name,
      gender: tutor.gender,
      isAgeConfirmed: tutor.isAgeConfirmed,
      rating: tutor.rating,
      ratingCount: tutor.ratingCount,
      isFeatured: tutor.isFeatured,
      qualification: tutor.qualification,
      specialization: tutor.specialization,
      experience: tutor.experience,
      teachingMode: tutor.teachingMode,
      tuitionType: tutor.tuitionType,
      city: tutor.city,
      state: tutor.state,
      subjects: tutor.subjects || [],
      classLevels: tutor.classLevels || [],
      boards: tutor.boards || [],
      exams: tutor.exams || [],
      studentTypes: tutor.studentTypes || [],
      groupSize: tutor.groupSize,
      groupSizes: tutor.groupSizes || [],
      hourlyRate: tutor.hourlyRate,
      monthlyRate: tutor.monthlyRate,
      availability: tutor.availability || [],
      bio: tutor.bio,
      achievements: tutor.achievements,
      photoUrl: tutor.photoUrl,
      demoVideoUrl: tutor.demoVideoUrl,
      isVerified: tutor.isVerified,
      status: tutor.status,
      kycStatus: tutor.kycStatus,
      createdAt: tutor.createdAt,
      updatedAt: tutor.updatedAt,
    };

    res.status(200).json({
      success: true,
      data: {
        ...safeTutor,
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




