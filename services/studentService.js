// services/studentService.js
const escapeRegex = (value = "") => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

exports.buildStudentFilter = (query) => {
  const {
    name,
    q,
    city,
    pincode,
    board,
    classLevel,
    subject,
    gender,
    availability
  } = query;

  const filter = {};
  const searchName = String(name || q || "").trim();
  const searchPincode = String(pincode || "").trim();

  if (searchName) filter.name = { $regex: escapeRegex(searchName), $options: "i" };
  if (city) filter.city = { $regex: city, $options: "i" };
  if (searchPincode) filter.pincode = { $regex: escapeRegex(searchPincode), $options: "i" };
  if (board) filter.board = { $regex: board, $options: "i" };
  if (classLevel) filter.classLevel = { $regex: classLevel, $options: "i" };
  if (subject) filter.subjects = { $regex: subject, $options: "i" };
  if (gender) filter.gender = gender;

  if (availability) {
    filter.availability = { $in: availability.split(",") };
  }

  return filter;
};
