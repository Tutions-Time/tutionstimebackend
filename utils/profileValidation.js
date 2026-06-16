const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PINCODE_REGEX = /^[0-9]{6}$/;
const PHONE_REGEX = /^[0-9]{10}$/;

const isEmpty = (v) => v === undefined || v === null || String(v).trim() === "";

const buildRateOptions = (start, end, step) =>
  Array.from(
    { length: Math.floor((end - start) / step) + 1 },
    (_, index) => start + index * step
  );

const HOURLY_RATE_OPTIONS = buildRateOptions(400, 2000, 100);
const MONTHLY_RATE_OPTIONS = buildRateOptions(3500, 10000, 100);

const isAllowedRate = (value, options) => options.includes(Number(value));

const parseBudget = (budget) => {
  const text = String(budget || "");
  return {
    hourly: text.match(/Hourly:\s*Rs\.(\d+)/i)?.[1] || "",
    monthly: text.match(/Monthly:\s*Rs\.(\d+)/i)?.[1] || "",
  };
};

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

const normalizeSubjectTimeSlots = (val) => {
  const items = normalizeArray(val);
  return items
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const subject = String(item.subject || "").trim();
      const slots = normalizeArray(item.slots);
      if (!subject) return null;
      return { subject, slots };
    })
    .filter(Boolean);
};

const validateStudentProfileData = (data) => {
  const errors = {};

  if (isEmpty(data.name)) errors.name = "Name is required";
  if (isEmpty(data.email) || !EMAIL_REGEX.test(String(data.email)))
    errors.email = "Valid email is required";

  if (isEmpty(data.altPhone)) {
    errors.altPhone = "Mobile number  is required";
  } else if (!PHONE_REGEX.test(String(data.altPhone))) {
    errors.altPhone = "Mobile number  must be 10 digits";
  }

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
    if (isEmpty(data.targetYear))
      errors.targetYear = "Target year is required";
    if (data.targetYear === "Other" && isEmpty(data.targetYearOther))
      errors.targetYearOther = "Please specify target year";
  }

  const subjects = normalizeArray(data.subjects);
  if (!subjects.length) errors.subjects = "Select at least one subject";

  if (isEmpty(data.tutorGenderPref))
    errors.tutorGenderPref = "Tutor gender preference is required";
  if (data.tutorGenderPref === "Other" && isEmpty(data.tutorGenderOther))
    errors.tutorGenderOther = "Please specify tutor gender";

  const subjectTimeSlots = normalizeSubjectTimeSlots(data.subjectTimeSlots);
  const subjectSlotMap = new Map(
    subjectTimeSlots.map((item) => [item.subject, item.slots])
  );
  const preferredTimes = normalizeArray(data.preferredTimes);
  const subjectsWithoutSlots = subjects.filter(
    (subject) => !(subjectSlotMap.get(subject) || []).length
  );
  if (subjectTimeSlots.length && subjectsWithoutSlots.length) {
    errors.preferredTimes = `Preferred time slot is required for ${subjectsWithoutSlots.join(", ")}`;
  } else if (!subjectTimeSlots.length && !preferredTimes.length) {
    errors.preferredTimes = "Preferred time slots are required";
  }

  const budget = parseBudget(data.budget);
  if (budget.hourly && budget.monthly) {
    errors.budget = "Select either hourly or monthly budget, not both";
  } else if (budget.hourly && !isAllowedRate(budget.hourly, HOURLY_RATE_OPTIONS)) {
    errors.budget = "Select an hourly budget from Rs.400 to Rs.2000";
  } else if (budget.monthly && !isAllowedRate(budget.monthly, MONTHLY_RATE_OPTIONS)) {
    errors.budget = "Select a monthly budget from Rs.3500 to Rs.10000";
  }

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

  if (isEmpty(data.altPhone)) {
    errors.altPhone = "Mobile number is required";
  } else if (!PHONE_REGEX.test(String(data.altPhone))) {
    errors.altPhone = "Mobile number must be 10 digits";
  }

  if (data.phone && !PHONE_REGEX.test(String(data.phone))) {
    errors.phone = "Phone must be 10 digits";
  }

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

  const classLevels = normalizeArray(data.classLevels);
  if (!classLevels.length)
    errors.classLevels = "Select at least one class level";

  const boards = normalizeArray(data.boards);
  if (!boards.length) errors.boards = "Select at least one board";

  const studentTypes = normalizeArray(data.studentTypes);
  if (!studentTypes.length)
    errors.studentTypes = "Select at least one student type";

  const groupSizes = normalizeArray(data.groupSizes);
  if (!groupSizes.length && isEmpty(data.groupSize))
    errors.groupSizes = "Select at least one group size";

  if (isEmpty(data.hourlyRate)) {
    errors.hourlyRate = "Hourly rate is required";
  } else if (!isAllowedRate(data.hourlyRate, HOURLY_RATE_OPTIONS)) {
    errors.hourlyRate = "Select an hourly rate from Rs.400 to Rs.2000";
  }

  if (isEmpty(data.monthlyRate)) {
    errors.monthlyRate = "Monthly rate is required";
  } else if (!isAllowedRate(data.monthlyRate, MONTHLY_RATE_OPTIONS)) {
    errors.monthlyRate = "Select a monthly rate from Rs.3500 to Rs.10000";
  }

  if (isEmpty(data.bio)) errors.bio = "Bio is required";

  if (isEmpty(data.photoUrl)) errors.photoUrl = "Profile photo is required";

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
  normalizeSubjectTimeSlots,
  validateStudentProfileData,
  validateTutorProfileData,
  isStudentProfileComplete,
  isTutorProfileComplete,
};
