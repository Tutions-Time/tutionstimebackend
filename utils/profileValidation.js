const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PINCODE_REGEX = /^[0-9]{6}$/;
const PHONE_REGEX = /^[0-9]{10}$/;

const isEmpty = (v) => v === undefined || v === null || String(v).trim() === "";

const normalizeArray = (val) => {
  if (!val) return [];
  if (Array.isArray(val)) return val.filter(Boolean);
  if (typeof val === "string") {
    try {
      const parsed = JSON.parse(val);
      if (Array.isArray(parsed)) return parsed.filter(Boolean);
    } catch {}
    return val
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
};

const validateStudentProfileData = (data) => {
  const errors = {};

  if (isEmpty(data.name)) errors.name = "Name is required";
  if (isEmpty(data.email) || !EMAIL_REGEX.test(String(data.email)))
    errors.email = "Valid email is required";

  if (isEmpty(data.altPhone)) {
    errors.altPhone = "Alternate phone is required";
  } else if (!PHONE_REGEX.test(String(data.altPhone))) {
    errors.altPhone = "Alternate phone must be 10 digits";
  }

  if (isEmpty(data.gender)) errors.gender = "Gender is required";
  if (data.gender === "Other" && isEmpty(data.genderOther))
    errors.genderOther = "Please specify gender";

  if (isEmpty(data.addressLine1))
    errors.addressLine1 = "Address line 1 is required";
  if (isEmpty(data.addressLine2))
    errors.addressLine2 = "Address line 2 is required";
  if (isEmpty(data.city)) errors.city = "City is required";
  if (isEmpty(data.state)) errors.state = "State is required";
  if (isEmpty(data.pincode) || !PINCODE_REGEX.test(String(data.pincode)))
    errors.pincode = "Valid 6 digit pincode is required";

  if (!["Online", "Offline", "Both"].includes(data.learningMode))
    errors.learningMode = "Learning mode must be Online, Offline, or Both";

  if (!["school", "college", "competitive"].includes(data.track))
    errors.track = "Learning track is required";

  if (data.track === "school") {
    if (isEmpty(data.board)) errors.board = "Board is required";
    if (data.board === "Other" && isEmpty(data.boardOther))
      errors.boardOther = "Please specify board";
    if (isEmpty(data.classLevel))
      errors.classLevel = "Class level is required";
    if (data.classLevel === "Other" && isEmpty(data.classLevelOther))
      errors.classLevelOther = "Please specify class";
    if (
      ["Class 11", "Class 12"].includes(data.classLevel) &&
      isEmpty(data.stream)
    )
      errors.stream = "Stream is required for Class 11/12";
    if (data.stream === "Other" && isEmpty(data.streamOther))
      errors.streamOther = "Please specify stream";
  }

  if (data.track === "college") {
    if (isEmpty(data.program)) errors.program = "Program is required";
    if (data.program === "Other" && isEmpty(data.programOther))
      errors.programOther = "Please specify program";
    if (isEmpty(data.discipline))
      errors.discipline = "Discipline is required";
    if (data.discipline === "Other" && isEmpty(data.disciplineOther))
      errors.disciplineOther = "Please specify discipline";
    if (isEmpty(data.yearSem)) errors.yearSem = "Year/Semester is required";
    if (data.yearSem === "Other" && isEmpty(data.yearSemOther))
      errors.yearSemOther = "Please specify year/semester";
  }

  if (data.track === "competitive") {
    if (isEmpty(data.exam)) errors.exam = "Exam is required";
    if (data.exam === "Other" && isEmpty(data.examOther))
      errors.examOther = "Please specify exam";
    if (isEmpty(data.targetYear))
      errors.targetYear = "Target year is required";
    if (data.targetYear === "Other" && isEmpty(data.targetYearOther))
      errors.targetYearOther = "Please specify target year";
  }

  const subjects = normalizeArray(data.subjects);
  if (!subjects.length) errors.subjects = "Select at least one subject";
  if (subjects.includes("Other") && isEmpty(data.subjectOther))
    errors.subjectOther = "Please specify subject";

  if (isEmpty(data.tutorGenderPref))
    errors.tutorGenderPref = "Tutor gender preference is required";
  if (data.tutorGenderPref === "Other" && isEmpty(data.tutorGenderOther))
    errors.tutorGenderOther = "Please specify tutor gender";

  const preferredTimes = normalizeArray(data.preferredTimes);
  if (!preferredTimes.length)
    errors.preferredTimes = "Preferred time slots are required";

  const availability = normalizeArray(data.availability);
  if (!availability.length)
    errors.availability = "Availability is required";

  if (isEmpty(data.goals)) errors.goals = "Learning goals are required";

  if (isEmpty(data.photoUrl))
    errors.photoUrl = "Profile photo is required";

  return errors;
};

const validateTutorProfileData = (data, options = {}) => {
  const errors = {};

  if (isEmpty(data.name)) errors.name = "Name is required";
  if (isEmpty(data.email) || !EMAIL_REGEX.test(String(data.email)))
    errors.email = "Valid email is required";

  if (isEmpty(data.phone)) {
    errors.phone = "Phone number is required";
  } else if (!PHONE_REGEX.test(String(data.phone))) {
    errors.phone = "Phone must be 10 digits";
  }

  if (isEmpty(data.gender)) errors.gender = "Gender is required";
  if (isEmpty(data.teachingMode))
    errors.teachingMode = "Teaching mode is required";

  if (isEmpty(data.addressLine1))
    errors.addressLine1 = "Address line 1 is required";
  if (isEmpty(data.addressLine2))
    errors.addressLine2 = "Address line 2 is required";
  if (isEmpty(data.city)) errors.city = "City is required";
  if (isEmpty(data.state)) errors.state = "State is required";
  if (isEmpty(data.pincode) || !PINCODE_REGEX.test(String(data.pincode)))
    errors.pincode = "Valid 6 digit pincode is required";

  if (isEmpty(data.qualification))
    errors.qualification = "Qualification is required";

  if (isEmpty(data.experience) || Number(data.experience) < 0)
    errors.experience = "Valid experience is required";

  const subjects = normalizeArray(data.subjects);
  if (!subjects.length) errors.subjects = "Select at least one subject";

  const classLevels = normalizeArray(data.classLevels);
  if (!classLevels.length)
    errors.classLevels = "Select at least one class level";

  const boards = normalizeArray(data.boards);
  if (!boards.length) errors.boards = "Select at least one board";

  const exams = normalizeArray(data.exams);
  if (!exams.length) errors.exams = "Select at least one exam";

  const studentTypes = normalizeArray(data.studentTypes);
  if (!studentTypes.length)
    errors.studentTypes = "Select at least one student type";

  const groupSizes = normalizeArray(data.groupSizes);
  if (!groupSizes.length && isEmpty(data.groupSize))
    errors.groupSizes = "Select at least one group size";

  if (isEmpty(data.hourlyRate) || Number(data.hourlyRate) <= 0)
    errors.hourlyRate = "Hourly rate must be greater than 0";

  if (isEmpty(data.monthlyRate) || Number(data.monthlyRate) <= 0)
    errors.monthlyRate = "Monthly rate must be greater than 0";

  const availability = normalizeArray(data.availability);
  if (!availability.length)
    errors.availability = "Availability is required";

  if (isEmpty(data.bio)) errors.bio = "Bio is required";

  if (isEmpty(data.photoUrl)) errors.photoUrl = "Profile photo is required";
  if (isEmpty(data.resumeUrl)) errors.resumeUrl = "Resume is required";
  if (isEmpty(data.demoVideoUrl)) errors.demoVideo = "Demo video is required";

  if (isEmpty(data.upiId)) errors.upiId = "UPI ID is required";
  if (isEmpty(data.accountHolderName))
    errors.accountHolderName = "Account holder name is required";
  if (isEmpty(data.bankAccountNumber))
    errors.bankAccountNumber = "Bank account number is required";
  if (isEmpty(data.ifsc)) errors.ifsc = "IFSC is required";

  if (!data.isAgeConfirmed)
    errors.isAgeConfirmed = "Age confirmation is required";

  return errors;
};

const isStudentProfileComplete = (profile) =>
  Object.keys(validateStudentProfileData(profile || {})).length === 0;

const isTutorProfileComplete = (profile) =>
  Object.keys(validateTutorProfileData(profile || {})).length === 0;

module.exports = {
  normalizeArray,
  validateStudentProfileData,
  validateTutorProfileData,
  isStudentProfileComplete,
  isTutorProfileComplete,
};
