const TutorProfile = require('../models/TutorProfile');
const { buildTutorFilter, getRecommendedTutors } = require('../services/tutorService');

exports.searchTutors = async (req, res) => {
  try {
    const hasFilters = Object.keys(req.query).length > 0;

    if (hasFilters) {
      // 🔹 Apply standard filters
      const filter = buildTutorFilter(req.query);
      const tutors = await TutorProfile.find(filter)
        .populate('userId', 'phone role')
        .sort({ createdAt: -1 })
        .limit(20)
        .lean();

      return res.status(200).json({
        success: true,
        mode: 'filter',
        count: tutors.length,
        data: tutors,
      });
    }

    // 🧠 No filters → Use AI recommendation
    const studentId = req.user?.id || null; // use JWT if logged in
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
