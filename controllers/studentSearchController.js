// controllers/studentSearchController.js
const StudentProfile = require('../models/StudentProfile');
const User = require('../models/User');
const { buildStudentFilter } = require('../services/studentService.js');

exports.searchStudents = async (req, res) => {
  try {
    const hasFilters = Object.keys(req.query).length > 0;

    // always search only students whose profile is complete
    const baseUserFilter = {
      role: "student",
      isProfileComplete: true,
      status: "active"
    };

    // Pagination
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    // Sorting
    const sortParam = req.query.sort || "createdAt_desc";
    let sort = {};
    const [field, order] = sortParam.split("_");
    sort[field] = order === "asc" ? 1 : -1;

    // Build student filters
    const studentFilters = hasFilters ? buildStudentFilter(req.query) : {};

    // get user IDs of valid students
    const validUsers = await User.find(baseUserFilter).select("_id").lean();
    const validUserIds = validUsers.map((u) => u._id);

    // final filter
    const finalFilter = {
      userId: { $in: validUserIds },
      ...studentFilters
    };

    // get students
    const students = await StudentProfile.find(finalFilter)
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .lean();

    const total = await StudentProfile.countDocuments(finalFilter);

    return res.status(200).json({
      success: true,
      page,
      total,
      count: students.length,
      data: students
    });
  } catch (error) {
    console.error("Search Students Error:", error);
    res.status(500).json({
      success: false,
      message: "Server Error",
      error: error.message,
    });
  }
};
