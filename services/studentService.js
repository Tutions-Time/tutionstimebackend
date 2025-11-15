// services/studentService.js
exports.buildStudentFilter = (query) => {
  const {
    city,
    pincode,
    board,
    classLevel,
    subject,
    gender,
    availability
  } = query;

  const filter = {};

  if (city) filter.city = { $regex: city, $options: "i" };
  if (pincode) filter.pincode = { $regex: pincode, $options: "i" };
  if (board) filter.board = { $regex: board, $options: "i" };
  if (classLevel) filter.classLevel = { $regex: classLevel, $options: "i" };
  if (subject) filter.subjects = { $regex: subject, $options: "i" };
  if (gender) filter.gender = gender;

  if (availability) {
    filter.availability = { $in: availability.split(",") };
  }

  return filter;
};
