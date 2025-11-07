const TutorProfile = require('../models/TutorProfile');
const StudentProfile = require('../models/StudentProfile');
const Booking = require('../models/Booking');

/**
 * 🧩 Build dynamic MongoDB filter based on query params
 */
exports.buildTutorFilter = (query) => {
  const {
    city,
    subject,
    classLevel,
    board,
    gender,
    teachingMode,
    minExp,
    maxExp,
    minRate,
    maxRate,
  } = query;

  const filter = { isVerified: true };

  if (city) filter['city'] = { $regex: city, $options: 'i' };
  if (subject) filter['subjects'] = { $regex: subject, $options: 'i' };
  if (classLevel) filter['classLevels'] = { $regex: classLevel, $options: 'i' };
  if (board) filter['boards'] = { $regex: board, $options: 'i' };
  if (gender) filter['gender'] = gender;
  if (teachingMode) filter['teachingMode'] = teachingMode;

  // 🔹 Experience range (assuming experience stored as number of years)
  if (minExp || maxExp) {
    filter['experience'] = {
      ...(minExp && { $gte: +minExp }),
      ...(maxExp && { $lte: +maxExp }),
    };
  }

  // 🔹 Rate range
  if (minRate || maxRate) {
    filter['hourlyRate'] = {
      ...(minRate && { $gte: +minRate }),
      ...(maxRate && { $lte: +maxRate }),
    };
  }

  return filter;
};

/**
 * 🧠 Simple AI Recommendation logic
 */
exports.getRecommendedTutors = async (studentId) => {
  const student = await StudentProfile.findOne({ userId: studentId }).lean();

  if (!student) {
    // fallback: return recent verified tutors
    return await TutorProfile.find({ isVerified: true })
      .sort({ createdAt: -1 })
      .limit(10)
      .lean();
  }

  const pastBookings = await Booking.find({ studentId }).lean();
  const pastTutorIds = pastBookings.map((b) => b.tutorId.toString());
  const subjects = student.subjects || [];
  const city = student.city;
  const learningGoals = student.goals || '';

  const tutors = await TutorProfile.find({
    isVerified: true,
    $or: [
      { subjects: { $in: subjects } },
      { city },
      { _id: { $in: pastTutorIds } },
      { bio: { $regex: learningGoals, $options: 'i' } },
    ],
  })
    .sort({ experience: -1, rating: -1, createdAt: -1 })
    .limit(15)
    .lean();

  return tutors;
};
