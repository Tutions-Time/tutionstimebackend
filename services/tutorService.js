const TutorProfile = require('../models/TutorProfile');
const StudentProfile = require('../models/StudentProfile');
const Booking = require('../models/Booking');

// 🔧 Build dynamic filters for normal search
exports.buildTutorFilter = (query) => {
  const { subject, classLevel, minRate, maxRate, language, pincode, teachingMode } = query;
  const filter = { isVerified: true };

  if (subject) filter.subjects = { $regex: subject, $options: 'i' };
  if (classLevel) filter.classLevels = { $regex: classLevel, $options: 'i' };
  if (language) filter.languages = { $regex: language, $options: 'i' };
  if (pincode) filter.pincode = pincode;
  if (teachingMode) filter.teachingMode = teachingMode;
  if (minRate || maxRate) {
    filter.hourlyRate = {
      ...(minRate && { $gte: +minRate }),
      ...(maxRate && { $lte: +maxRate }),
    };
  }
  return filter;
};

// 🧠 Simple AI Recommendation (rule-based)
exports.getRecommendedTutors = async (studentId) => {
  const student = await StudentProfile.findOne({ userId: studentId }).lean();
  if (!student) {
    // fallback: show general verified tutors if student profile not found
    return await TutorProfile.find({ isVerified: true })
      .sort({ createdAt: -1 })
      .limit(10)
      .lean();
  }

  const pastBookings = await Booking.find({ studentId }).lean();
  const pastTutorIds = pastBookings.map((b) => b.tutorId.toString());
  const subjects = student.subjects || [];
  const pincode = student.pincode;
  const learningGoals = student.goals || '';

  // Match tutors who share subjects or location or past interactions
  const tutors = await TutorProfile.find({
    isVerified: true,
    $or: [
      { subjects: { $in: subjects } },
      { pincode },
      { _id: { $in: pastTutorIds } },
      { bio: { $regex: learningGoals, $options: 'i' } },
    ],
  })
    .sort({ rating: -1, experience: -1 })
    .limit(15)
    .lean();

  return tutors;
};
