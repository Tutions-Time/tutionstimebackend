const User = require("../models/User");
const StudentProfile = require("../models/StudentProfile");
const TutorProfile = require("../models/TutorProfile");
                                                         
/* ------------------------------------------------------------
   GET USER PROFILE
------------------------------------------------------------ */
const getUserProfile = async (req, res) => {
  try {
    const userId = req.user.id;
    const user = await User.findById(userId).select("-refreshToken -password");
    if (!user)
      return res.status(404).json({ success: false, message: "User not found" });

    let profile = null;
    let roleDetails = {};

    if (user.role === "student") {
      profile = await StudentProfile.findOne({ userId }).lean();
    } else if (user.role === "tutor") {
      const tutor = await TutorProfile.findOne({ userId }).lean();
      if (tutor) {
        roleDetails = {
          kycStatus: tutor.kycStatus || "pending",
          hasKyc: !!(tutor.aadhaarUrls?.length || tutor.panUrl),
          isVerified: tutor.status === "approved",
        };
        profile = tutor;
      }
    }

    res.status(200).json({
      success: true,
      data: {
        user: {
          id: user._id,
          phone: user.phone,
          role: user.role,
          email: user.email,
          isProfileComplete: user.isProfileComplete,
          status: user.status,
          lastLogin: user.lastLogin,
          createdAt: user.createdAt,
          updatedAt: user.updatedAt,
        },
        profile: profile || null,
        roleDetails,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: "Server error", error: error.message });
  }
};

/* ------------------------------------------------------------
   GET FULL STUDENT PROFILE (FOR TUTOR VIEW)
   GET /api/users/student-profile/:studentUserId
------------------------------------------------------------ */
const getStudentProfileForTutor = async (req, res) => {
  try {
    const tutorUserId = req.user.id; // logged-in user (should be tutor)
    const { studentUserId } = req.params;

    // Safety: make sure logged-in user is actually a tutor
    const tutorUser = await User.findById(tutorUserId);
    if (!tutorUser || tutorUser.role !== "tutor") {
      return res.status(403).json({
        success: false,
        message: "Only tutors can view student profiles",
      });
    }

    // 1) Load the student user
    const studentUser = await User.findById(studentUserId).select(
      "-password -refreshToken"
    );

    if (!studentUser || studentUser.role !== "student") {
      return res.status(404).json({
        success: false,
        message: "Student user not found",
      });
    }

    // 2) Load the student profile
    const profile = await StudentProfile.findOne({ userId: studentUserId }).lean();

    if (!profile) {
      return res.status(404).json({
        success: false,
        message: "Student profile not found",
      });
    }

    // 3) Return combined data (similar shape to getUserProfile)
    return res.status(200).json({
      success: true,
      data: {
        user: {
          id: studentUser._id,
          phone: studentUser.phone,
          role: studentUser.role,
          email: studentUser.email,
          isProfileComplete: studentUser.isProfileComplete,
          status: studentUser.status,
          lastLogin: studentUser.lastLogin,
          createdAt: studentUser.createdAt,
          updatedAt: studentUser.updatedAt,
        },
        profile,       // full StudentProfile (name, city, board, classLevel, subjects, etc.)
      },
    });
  } catch (error) {
    console.error("Error in getStudentProfileForTutor:", error);
    return res.status(500).json({
      success: false,
      message: "Server error while fetching student profile",
      error: error.message,
    });
  }
};


/* ------------------------------------------------------------
   UPDATE STUDENT PROFILE
------------------------------------------------------------ */
const updateStudentProfile = async (req, res) => {
  try {
    const userId = req.user.id;

    const user = await User.findById(userId);
    if (!user)
      return res.status(404).json({ success: false, message: "User not found" });

    if (user.role !== "student")
      return res.status(403).json({
        success: false,
        message: "Only students can update student profiles",
      });

    const parseArray = (raw) => {
      if (!raw) return [];
      if (Array.isArray(raw)) return raw;
      if (typeof raw === "string") {
        try {
          const v = JSON.parse(raw);
          if (Array.isArray(v)) return v;
        } catch {}
        return raw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      }
      return [];
    };

    // ⭐ S3 path
    let photoUrl = null;
    if (req.files?.photo) {
      photoUrl = req.files.photo[0].location; // <-- AWS S3 URL
    }

    const b = req.body;

    if (!b.name || !b.email)
      return res
        .status(400)
        .json({ success: false, message: "Name and email are required" });

    if (b.track === "school" && !b.classLevel)
      return res
        .status(400)
        .json({ success: false, message: "classLevel is required for school track" });

    if (b.track === "college" && (!b.program || !b.discipline || !b.yearSem))
      return res.status(400).json({
        success: false,
        message: "program, discipline and yearSem are required for college track",
      });

    if (b.track === "competitive" && !b.exam)
      return res.status(400).json({
        success: false,
        message: "exam is required for competitive track",
      });

    const profileData = {
      userId,
      name: b.name,
      email: b.email,
      altPhone: b.altPhone || "",
      gender: b.gender || "",
      genderOther: b.gender === "Other" ? b.genderOther || "" : "",
      addressLine1: b.addressLine1 || "",
      addressLine2: b.addressLine2 || "",
      city: b.city || "",
      state: b.state || "",
      pincode: b.pincode || "",
      track: b.track || "",
      board: b.board || "",
      boardOther: b.board === "Other" ? b.boardOther || "" : "",
      classLevel: b.classLevel || "",
      classLevelOther: b.classLevel === "Other" ? b.classLevelOther || "" : "",
      stream: b.stream || "",
      streamOther: b.stream === "Other" ? b.streamOther || "" : "",
      program: b.program || "",
      programOther: b.program === "Other" ? b.programOther || "" : "",
      discipline: b.discipline || "",
      disciplineOther: b.discipline === "Other" ? b.disciplineOther || "" : "",
      yearSem: b.yearSem || "",
      yearSemOther: b.yearSem === "Other" ? b.yearSemOther || "" : "",
      exam: b.exam || "",
      examOther: b.exam === "Other" ? b.examOther || "" : "",
      targetYear: b.targetYear || "",
      targetYearOther: b.targetYear === "Other" ? b.targetYearOther || "" : "",
      subjects: parseArray(b.subjects),
      subjectOther: (() => {
        const subs = parseArray(b.subjects);
        return subs.includes("Other") ? b.subjectOther || "" : "";
      })(),
      tutorGenderPref: b.tutorGenderPref || "No Preference",
      tutorGenderOther:
        b.tutorGenderPref === "Other" ? b.tutorGenderOther || "" : "",
      preferredTimes: parseArray(b.preferredTimes),
      availability: parseArray(b.availability),
      goals: b.goals || "",
      ...(photoUrl && { photoUrl }),
    };

    const profile = await StudentProfile.findOneAndUpdate(
      { userId },
      { $set: profileData },
      { new: true, upsert: true }
    );

    if (!user.isProfileComplete) {
      user.isProfileComplete = true;
      await user.save();
    }

    res.status(200).json({
      success: true,
      message: "Student profile updated successfully",
      data: profile,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
};

/* ------------------------------------------------------------
   UPLOAD TUTOR KYC (Aadhaar + PAN)
------------------------------------------------------------ */
const uploadTutorKyc = async (req, res) => {
  try {
    const userId = req.user.id;
    const tutor = await TutorProfile.findOne({ userId });

    if (!tutor)
      return res.status(404).json({
        success: false,
        message: "Tutor profile not found",
      });

    const aadhaarUrls = [];

    if (req.files?.aadhaar) {
      req.files.aadhaar.forEach((file) => aadhaarUrls.push(file.location)); // <-- S3 URL
    }

    const panUrl = req.files?.pan?.[0]
      ? req.files.pan[0].location
      : tutor.panUrl;

    tutor.aadhaarUrls = aadhaarUrls.length ? aadhaarUrls : tutor.aadhaarUrls;
    tutor.panUrl = panUrl;
    tutor.kycStatus = "submitted";

    await tutor.save();

    res.status(200).json({
      success: true,
      message: "KYC documents submitted successfully",
      data: tutor,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server error while uploading KYC",
      error: error.message,
    });
  }
};

/* ------------------------------------------------------------
   UPDATE TUTOR PROFILE
------------------------------------------------------------ */
const updateTutorProfile = async (req, res) => {
  try {
    const userId = req.user.id;

    const user = await User.findById(userId);
    if (!user)
      return res
        .status(404)
        .json({ success: false, message: "User not found" });

    if (user.role !== "tutor")
      return res.status(403).json({
        success: false,
        message: "Only tutors can update tutor profiles",
      });

    const {
      name,
      email,
      gender,
      qualification,
      specialization,
      experience,
      subjects,
      classLevels,
      boards,
      exams,
      studentTypes,
      groupSize,
      teachingMode,
      hourlyRate,
      monthlyRate,
      availability,
      bio,
      achievements,
      addressLine1,
      addressLine2,
      city,
      state,
      pincode,
      upiId,
      accountHolderName,
      bankAccountNumber,
      ifsc,
    } = req.body;

    if (!name || !email || !gender || !qualification || !subjects || !hourlyRate || !bio) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields",
      });
    }

    // ⭐ AWS S3 returns file.location
    let photoUrl = null,
      demoVideoUrl = null,
      resumeUrl = null;

    if (req.files?.photo)
      photoUrl = req.files.photo[0].location;

    if (req.files?.demoVideo)
      demoVideoUrl = req.files.demoVideo[0].location;

    if (req.files?.resume)
      resumeUrl = req.files.resume[0].location;

    const parseArray = (val) => {
      try {
        if (!val) return [];
        const parsed = JSON.parse(val);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    };

    const profileData = {
      userId,
      name,
      email,
      gender,
      qualification,
      specialization,
      experience: Number(experience) || 0,
      subjects: parseArray(subjects),
      classLevels: parseArray(classLevels),
      boards: parseArray(boards),
      exams: parseArray(exams),
      studentTypes: parseArray(studentTypes),
      groupSize,
      teachingMode,
      hourlyRate: parseFloat(hourlyRate) || 0,
      monthlyRate: parseFloat(monthlyRate) || 0,
      availability: parseArray(availability),
      bio,
      achievements,
      addressLine1,
      addressLine2,
      city,
      state,
      pincode,
      ...(photoUrl && { photoUrl }),
      ...(demoVideoUrl && { demoVideoUrl }),
      ...(resumeUrl && { resumeUrl }),
      ...(upiId && { upiId }),
      ...(accountHolderName && { accountHolderName }),
      ...(bankAccountNumber && { bankAccountNumber }),
      ...(ifsc && { ifsc }),
    };

    const profile = await TutorProfile.findOneAndUpdate(
      { userId },
      { $set: profileData },
      { new: true, upsert: true }
    );

    if (!user.isProfileComplete) {
      user.isProfileComplete = true;
      await user.save();
    }

    res.status(200).json({
      success: true,
      message: "Tutor profile updated successfully",
      data: profile,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server error while updating tutor profile",
      error: error.message,
    });
  }
};

/* ------------------------------------------------------------
   GET ALL USERS
------------------------------------------------------------ */
const getAllUsers = async (req, res) => {
  try {
    const users = await User.find().select("-password -refreshToken");
    res.status(200).json({ success: true, count: users.length, data: users });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
};

module.exports = {
  getUserProfile,
  updateStudentProfile,
  updateTutorProfile,
  getAllUsers,
  uploadTutorKyc,
  getStudentProfileForTutor
};
