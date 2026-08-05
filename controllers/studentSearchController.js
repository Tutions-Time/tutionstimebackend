// controllers/studentSearchController.js
const StudentProfile = require('../models/StudentProfile');
const TutorProfile = require('../models/TutorProfile');
const User = require('../models/User');
const { buildStudentFilter } = require('../services/studentService.js');

const escapeRegex = (value = "") => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const valuesToExactRegex = (values = []) =>
  values
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .map((value) => new RegExp(`^\\s*${escapeRegex(value)}\\s*$`, "i"));

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

    const tutorProfile = await TutorProfile
      .findOne({ userId: req.user.id })
      .select("teachingMode pincode classLevels subjects")
      .lean();
    const isOfflineOnlyTutor =
      String(tutorProfile?.teachingMode || "").trim().toLowerCase() === "offline";
    const tutorPincode = String(tutorProfile?.pincode || "").trim();
    const tutorClassLevels = valuesToExactRegex(tutorProfile?.classLevels || []);
    const tutorSubjects = valuesToExactRegex(tutorProfile?.subjects || []);

    if (tutorClassLevels.length) {
      studentFilters.$and = [
        ...(studentFilters.$and || []),
        { classLevel: { $in: tutorClassLevels } },
      ];
    }

    if (tutorSubjects.length) {
      studentFilters.$and = [
        ...(studentFilters.$and || []),
        {
          $or: [
            { subjects: { $in: tutorSubjects } },
            { "subjectTimeSlots.subject": { $in: tutorSubjects } },
          ],
        },
      ];
    }

    if (isOfflineOnlyTutor) {
      studentFilters.learningMode = "Offline";
      if (tutorPincode) {
        studentFilters.pincode = tutorPincode;
      } else {
        studentFilters._id = { $exists: false };
      }
    }

    // get user IDs of valid students
    const validUsers = await User.find(baseUserFilter).select("_id").lean();
    const validUserIds = validUsers.map((u) => u._id);

    // final filter
    const finalFilter = {
      userId: { $in: validUserIds },
      ...studentFilters
    };

    const students = await StudentProfile.find(finalFilter)
      .sort(sort)
      .lean();

    const requestedSubject = String(req.query.subject || "").trim().toLowerCase();
    const matchesTutorSubject = (subject) =>
      !tutorSubjects.length ||
      tutorSubjects.some((regex) => regex.test(String(subject || "")));
    const subjectMatches = (subject) => {
      const normalizedSubject = String(subject || "").trim().toLowerCase();
      return (
        matchesTutorSubject(subject) &&
        (!requestedSubject || normalizedSubject.includes(requestedSubject))
      );
    };

    const leads = students.flatMap((student) => {
      const subjectTimeSlots = Array.isArray(student.subjectTimeSlots)
        ? student.subjectTimeSlots
            .filter((item) => item?.subject && subjectMatches(item.subject))
            .flatMap((item) => {
              const slots = Array.isArray(item.slots)
                ? item.slots.filter(Boolean)
                : [];
              if (!slots.length) {
                return [{
                  ...student,
                  profileId: student._id,
                  leadId: `${student._id}:${item.subject}`,
                  leadSubject: item.subject,
                  subjects: [item.subject],
                  preferredTimeSlot: "",
                  preferredTimes: [],
                }];
              }
              return slots.map((slot, index) => ({
                ...student,
                profileId: student._id,
                leadId: `${student._id}:${item.subject}:${index}`,
                leadSubject: item.subject,
                subjects: [item.subject],
                preferredTimeSlot: slot,
                preferredTimes: [slot],
              }));
            })
        : [];

      if (subjectTimeSlots.length) return subjectTimeSlots;

      const preferredTimes = Array.isArray(student.preferredTimes)
        ? student.preferredTimes.filter(Boolean)
        : [];
      const subjects = Array.isArray(student.subjects)
        ? student.subjects.filter((subject) => subjectMatches(subject))
        : [];
      const fallbackSubjects = subjects.length ? subjects : [""];

      if (!preferredTimes.length) {
        return fallbackSubjects.map((subject, index) => ({
          ...student,
          profileId: student._id,
          leadId: `${student._id}:${subject || "lead"}:${index}`,
          leadSubject: subject,
          subjects: subject ? [subject] : student.subjects,
          preferredTimeSlot: "",
        }));
      }

      return fallbackSubjects.flatMap((subject) =>
        preferredTimes.map((slot, index) => ({
          ...student,
          profileId: student._id,
          leadId: `${student._id}:${subject || "lead"}:${index}`,
          leadSubject: subject,
          subjects: subject ? [subject] : student.subjects,
          preferredTimeSlot: slot,
          preferredTimes: [slot],
        }))
      );
    });

    const paginatedLeads = leads.slice(skip, skip + limit);

    return res.status(200).json({
      success: true,
      page,
      total: leads.length,
      count: paginatedLeads.length,
      data: paginatedLeads
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

