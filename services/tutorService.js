const TutorProfile = require('../models/TutorProfile');
const StudentProfile = require('../models/StudentProfile');
const Booking = require('../models/Booking');

const parseStudentBudget = (budget = '') => {
  const text = String(budget || '');
  const hourly = Number(text.match(/Hourly:\s*(?:Rs\.?|₹)?\s*(\d+)/i)?.[1] || 0);
  const monthly = Number(text.match(/Monthly:\s*(?:Rs\.?|₹)?\s*(\d+)/i)?.[1] || 0);

  return {
    hourly: Number.isFinite(hourly) && hourly > 0 ? hourly : null,
    monthly: Number.isFinite(monthly) && monthly > 0 ? monthly : null,
  };
};

const mergeMaxRate = (existing, max) => {
  if (!max) return existing;
  const current = existing && typeof existing === 'object' ? existing : {};
  return {
    ...current,
    $lte: current.$lte ? Math.min(Number(current.$lte), max) : max,
  };
};

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
      .select("learningMode pincode budget")
      .lean();

    const isOfflineOnly = String(student?.learningMode || "").toLowerCase() === "offline";
    const studentPincode = String(student?.pincode || "").trim();
    const budget = parseStudentBudget(student?.budget);

    if (isOfflineOnly) {
      filter["teachingMode"] = { $in: ["Offline", "Both"] };
      if (studentPincode) {
        filter["pincode"] = studentPincode;
      }
    }

    if (budget.hourly) {
      filter["hourlyRate"] = mergeMaxRate(filter["hourlyRate"], budget.hourly);
    }
    if (budget.monthly) {
      filter["monthlyRate"] = mergeMaxRate(filter["monthlyRate"], budget.monthly);
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
  const budget = parseStudentBudget(student.budget);

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

  if (budget.hourly) {
    query.hourlyRate = { $lte: budget.hourly };
  }
  if (budget.monthly) {
    query.monthlyRate = { $lte: budget.monthly };
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
