const TutorProfile = require('../models/TutorProfile');
const { buildTutorFilter, getRecommendedTutors } = require('../services/tutorService');

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
      const filter = buildTutorFilter(req.query);

      // Sorting
      const sortParam = req.query.sort || 'createdAt_desc';
      let sort = {};
      const [field, order] = sortParam.split('_');
      sort[field] = order === 'asc' ? 1 : -1;

      // Pagination
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 20;
      const skip = (page - 1) * limit;

      // Fetch tutors
      const tutors = await TutorProfile.find(filter)
        .populate('userId', 'phone role')
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .lean();

      const total = await TutorProfile.countDocuments(filter);

      return res.status(200).json({
        success: true,
        mode: 'filter',
        page,
        total,
        count: tutors.length,
        data: tutors,
      });
    }

    // 🧠 No filters → Use AI recommendation logic
    const studentId = req.user?.id || null;
    const recommended = await getRecommendedTutors(studentId);

    return res.status(200).json({
      success: true,
      mode: 'ai',
      count: recommended.length,
      data: recommended,
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
      .populate('userId', 'phone role email')
      .lean();

    if (!tutor) {
      return res.status(404).json({
        success: false,
        message: 'Tutor not found',
      });
    }

    res.status(200).json({
      success: true,
      data: tutor,
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
