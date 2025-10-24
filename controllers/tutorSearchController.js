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
