const TutorProfile = require('../models/TutorProfile');
const StudentProfile = require('../models/StudentProfile');
const Booking = require('../models/Booking');

/**
 * 🧩 Build dynamic MongoDB filter based on query params
 */
exports.buildTutorFilter = async (query, options = {}) => {
  const {
    city,
    pincode,  
    subject,
    classLevel,
    board,
    gender,
    teachingMode,
    tuitionType,
    minExp,
    maxExp,
    minRate,
    maxRate,
  } = query;
  const { studentId = null } = options;

  const filter = { isVerified: true };

  if (city) filter['city'] = { $regex: city, $options: 'i' };
  if (subject) filter['subjects'] = { $regex: subject, $options: 'i' };
  if (classLevel) filter['classLevels'] = { $regex: classLevel, $options: 'i' };
  if (board) filter['boards'] = { $regex: board, $options: 'i' };
  if (gender) filter['gender'] = gender;
  if (teachingMode) filter['teachingMode'] = teachingMode;
  if (pincode) filter['pincode'] = { $regex: pincode, $options: 'i' };

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

  if (studentId) {
    const student = await StudentProfile.findOne({ userId: studentId })
      .select("learningMode pincode")
      .lean();

    const isOfflineOnly = String(student?.learningMode || "").toLowerCase() === "offline";
    const studentPincode = String(student?.pincode || "").trim();

    if (isOfflineOnly) {
      filter["teachingMode"] = { $in: ["Offline", "Both"] };
      if (studentPincode) {
        filter["pincode"] = studentPincode;
      }
    }
  }

  return filter;
};

/**
 * 🧠 Simple AI Recommendation logic
 */
exports.getRecommendedTutors = async (studentId) => {
  const student = await StudentProfile.findOne({ userId: studentId }).lean();

  if (!student) {
    const tutors = await TutorProfile.find({ isVerified: true })
      .sort({ createdAt: -1 })
      .limit(10)
      .lean();
    const userIds = tutors.map((t) => t.userId).filter(Boolean);
    if (!userIds.length) return [];
    const User = require('../models/User');
    const users = await User.find({ _id: { $in: userIds } })
      .select('_id status')
      .lean();
    const active = new Set(
      users.filter((u) => String(u.status || '').toLowerCase() !== 'suspended').map((u) => String(u._id))
    );
    return tutors.filter((t) => active.has(String(t.userId)));
  }

  const pastBookings = await Booking.find({ studentId }).lean();
  const pastTutorIds = pastBookings.map((b) => b.tutorId.toString());
  const subjects = student.subjects || [];
  const city = student.city;
  const learningGoals = student.goals || '';
  const isOfflineOnly =
    String(student.learningMode || "").toLowerCase() === "offline";
  const studentPincode = String(student.pincode || "").trim();

  const query = {
    isVerified: true,
    $or: [
      { subjects: { $in: subjects } },
      { city },
      { _id: { $in: pastTutorIds } },
      { bio: { $regex: learningGoals, $options: 'i' } },
    ],
  };

  if (isOfflineOnly) {
    query.teachingMode = { $in: ["Offline", "Both"] };
    if (studentPincode) {
      query.pincode = studentPincode;
    }
  }

  const tutors = await TutorProfile.find(query)
    .sort({ experience: -1, rating: -1, createdAt: -1 })
    .limit(15)
    .lean();

  const userIds = tutors.map((t) => t.userId).filter(Boolean);
  if (!userIds.length) return [];
  const User = require('../models/User');
  const users = await User.find({ _id: { $in: userIds } })
    .select('_id status')
    .lean();
  const active = new Set(
    users.filter((u) => String(u.status || '').toLowerCase() !== 'suspended').map((u) => String(u._id))
  );
  return tutors.filter((t) => active.has(String(t.userId)));
};
