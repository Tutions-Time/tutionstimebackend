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

  if (data.altPhone && !PHONE_REGEX.test(String(data.altPhone)))
    errors.altPhone = "Alternate phone must be 10 digits";

  if (isEmpty(data.gender)) errors.gender = "Gender is required";
  if (data.gender === "Other" && isEmpty(data.genderOther))
    errors.genderOther = "Please specify gender";

  if (isEmpty(data.addressLine1))
    errors.addressLine1 = "Address line 1 is required";
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
  }

  const subjects = normalizeArray(data.subjects);
  if (!subjects.length) errors.subjects = "Select at least one subject";
  if (subjects.includes("Other") && isEmpty(data.subjectOther)) {
    if (subjects.length === 1) {
      errors.subjectOther = "Please specify subject";
    }
  }

  if (data.tutorGenderPref === "Other" && isEmpty(data.tutorGenderOther))
    errors.tutorGenderOther = "Please specify tutor gender";

  return errors;
};

const validateTutorProfileData = (data, options = {}) => {
  const errors = {};
  const requireDemoVideo = Boolean(options.requireDemoVideo);

  if (isEmpty(data.name)) errors.name = "Name is required";
  if (isEmpty(data.email) || !EMAIL_REGEX.test(String(data.email)))
    errors.email = "Valid email is required";

  if (data.phone && !PHONE_REGEX.test(String(data.phone)))
    errors.phone = "Phone must be 10 digits";

  if (isEmpty(data.gender)) errors.gender = "Gender is required";
  if (isEmpty(data.teachingMode))
    errors.teachingMode = "Teaching mode is required";

  if (isEmpty(data.addressLine1))
    errors.addressLine1 = "Address line 1 is required";
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

  if (isEmpty(data.hourlyRate) || Number(data.hourlyRate) <= 0)
    errors.hourlyRate = "Hourly rate must be greater than 0";

  if (isEmpty(data.bio)) errors.bio = "Bio is required";

  if (requireDemoVideo && isEmpty(data.demoVideoUrl))
    errors.demoVideo = "Demo video is required";

  return errors;
};

const isStudentProfileComplete = (profile) =>
  Object.keys(validateStudentProfileData(profile || {})).length === 0;

const isTutorProfileComplete = (profile) =>
  Object.keys(
    validateTutorProfileData(profile || {}, { requireDemoVideo: true })
  ).length === 0;

module.exports = {
  normalizeArray,
  validateStudentProfileData,
  validateTutorProfileData,
  isStudentProfileComplete,
  isTutorProfileComplete,
};
