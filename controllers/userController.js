const User = require("../models/User");
const StudentProfile = require("../models/StudentProfile");
const TutorProfile = require("../models/TutorProfile");
const {
  normalizeArray,
  validateStudentProfileData,
  validateTutorProfileData,
  isStudentProfileComplete,
  isTutorProfileComplete,
} = require("../utils/profileValidation");
                                                         
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
    let referralCodeStr = null;

    try {
      const ReferralCode = require("../models/ReferralCode");
      const mine = await ReferralCode.findOne({ ownerUserId: userId }).lean();
      referralCodeStr = mine?.code || null;
    } catch (_) {}

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
        referralCode: referralCodeStr,
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

    // â­ S3 path
    const existingProfile = await StudentProfile.findOne({ userId }).lean();
    let photoUrl = null;
    if (req.files?.photo) {
      photoUrl = req.files.photo[0].location; // <-- AWS S3 URL
    }

    const b = req.body;
    const resolvedPhotoUrl = photoUrl || existingProfile?.photoUrl || "";
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
      learningMode: b.learningMode || "",
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
      subjects: normalizeArray(b.subjects),
      tutorGenderPref: b.tutorGenderPref || "No Preference",
      tutorGenderOther:
        b.tutorGenderPref === "Other" ? b.tutorGenderOther || "" : "",
      preferredTimes: normalizeArray(b.preferredTimes),
      availability: normalizeArray(b.availability),
      goals: b.goals || "",
      photoUrl: resolvedPhotoUrl,
    };

    const errors = validateStudentProfileData(profileData);
    if (Object.keys(errors).length > 0) {
      return res.status(400).json({
        success: false,
        message: "Validation failed",
        errors,
      });
    }

    const profile = await StudentProfile.findOneAndUpdate(
      { userId },
      { $set: profileData },
      { new: true, upsert: true }
    );

    const isComplete = isStudentProfileComplete(profile);
    if (user.isProfileComplete !== isComplete) {
      user.isProfileComplete = isComplete;
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
      isAgeConfirmed,
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
      groupSizes,
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
    } = req.body;

    const existingProfile = await TutorProfile.findOne({ userId }).lean();

    // â­ AWS S3 returns file.location
    let photoUrl = null,
      demoVideoUrl = null,
      resumeUrl = null;

    if (req.files?.photo)
      photoUrl = req.files.photo[0].location;

    if (req.files?.demoVideo)
      demoVideoUrl = req.files.demoVideo[0].location;

    if (req.files?.resume)
      resumeUrl = req.files.resume[0].location;

    const parsedGroupSizes = normalizeArray(groupSizes);
    const resolvedPhotoUrl = photoUrl || existingProfile?.photoUrl || "";
    const resolvedDemoVideoUrl = demoVideoUrl || existingProfile?.demoVideoUrl || "";
    const resolvedResumeUrl = resumeUrl || existingProfile?.resumeUrl || "";
    const resolvedIsAgeConfirmed =
      typeof isAgeConfirmed === "undefined"
        ? Boolean(existingProfile?.isAgeConfirmed)
        : String(isAgeConfirmed) === "true" || isAgeConfirmed === true;
    const profileData = {
      userId,
      name,
      email,
      gender,
      qualification,
      specialization,
      experience: Number(experience) || 0,
      subjects: normalizeArray(subjects),
      classLevels: normalizeArray(classLevels),
      boards: normalizeArray(boards),
      exams: normalizeArray(exams),
      studentTypes: normalizeArray(studentTypes),
      groupSize: groupSize || parsedGroupSizes[0] || "",
      groupSizes: parsedGroupSizes,
      teachingMode,
      hourlyRate: parseFloat(hourlyRate) || 0,
      monthlyRate: parseFloat(monthlyRate) || 0,
      availability: normalizeArray(availability),
      bio,
      achievements,
      isAgeConfirmed: resolvedIsAgeConfirmed,
      addressLine1,
      addressLine2,
      city,
      state,
      pincode,
      ...(resolvedPhotoUrl && { photoUrl: resolvedPhotoUrl }),
      ...(resolvedDemoVideoUrl && { demoVideoUrl: resolvedDemoVideoUrl }),
      ...(resolvedResumeUrl && { resumeUrl: resolvedResumeUrl }),
    };

    const validationPayload = {
      ...profileData,
      photoUrl: resolvedPhotoUrl,
      demoVideoUrl: resolvedDemoVideoUrl,
      resumeUrl: resolvedResumeUrl,
      isAgeConfirmed: resolvedIsAgeConfirmed,
    };
    const errors = validateTutorProfileData(validationPayload);
    if (Object.keys(errors).length > 0) {
      return res.status(400).json({
        success: false,
        message: "Validation failed",
        errors,
      });
    }

    const profile = await TutorProfile.findOneAndUpdate(
      { userId },
      { $set: profileData },
      { new: true, upsert: true }
    );

    const safeProfile = profile?.toObject ? profile.toObject() : profile || {};
    const isComplete = isTutorProfileComplete({
      ...safeProfile,
      demoVideoUrl: resolvedDemoVideoUrl || safeProfile.demoVideoUrl || "",
    });
    if (user.isProfileComplete !== isComplete) {
      user.isProfileComplete = isComplete;
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
