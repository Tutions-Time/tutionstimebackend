const User = require("../models/User");
const StudentProfile = require("../models/StudentProfile");
const TutorProfile = require("../models/TutorProfile");
const {
  normalizeArray,
  normalizeSubjectTimeSlots,
  validateStudentProfileData,
  validateTutorProfileData,
  isStudentProfileComplete,
  isTutorProfileComplete,
} = require("../utils/profileValidation");
const { createAdminNotification } = require("../services/adminNotification");
const notificationService = require("../services/notificationService");

const UPI_REGEX = /^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z]{2,64}$/;
const IFSC_REGEX = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const BANK_ACCOUNT_REGEX = /^[0-9]{9,18}$/;

function hasTutorPayoutDetails(profile) {
  return Boolean(
    profile?.upiId &&
      profile?.accountHolderName &&
      profile?.bankAccountNumber &&
      profile?.ifsc
  );
}

function hasTutorKycDocuments(profile) {
  return Boolean(profile?.aadhaarUrls?.length && profile?.panUrl);
}

function getCombinedTutorKycStatus(profile) {
  if (!profile) return "pending";
  if (
    profile.payoutDetailsStatus === "approved" &&
    profile.kycDocumentsStatus === "approved"
  ) {
    return "approved";
  }
  if (
    profile.payoutDetailsStatus === "rejected" ||
    profile.kycDocumentsStatus === "rejected"
  ) {
    return "rejected";
  }
  if (hasTutorPayoutDetails(profile) && hasTutorKycDocuments(profile)) {
    return "submitted";
  }
  return "pending";
}

async function notifyTutorsForStudentPincode(studentProfile, studentUserId) {
  const pincode = String(studentProfile?.pincode || "").trim();
  if (!pincode) return;

  const tutors = await TutorProfile.find({ pincode })
    .select("_id userId name email subjects city pincode")
    .lean();
  if (!tutors.length) return;

  const tutorUserIds = tutors.map((t) => t.userId).filter(Boolean);
  if (!tutorUserIds.length) return;

  const activeTutorUsers = await User.find({
    _id: { $in: tutorUserIds },
    role: "tutor",
    status: "active",
    isDeleted: { $ne: true },
    isProfileComplete: true,
  })
    .select("_id")
    .lean();
  const activeTutorUserIds = new Set(activeTutorUsers.map((u) => String(u._id)));

  const studentName = studentProfile?.name || "A student";
  const subjects = Array.isArray(studentProfile?.subjects)
    ? studentProfile.subjects.filter(Boolean).slice(0, 3).join(", ")
    : "";
  const classText = studentProfile?.classLevel ? `, ${studentProfile.classLevel}` : "";
  const subjectText = subjects ? ` for ${subjects}` : "";
  const title = "New student near you";
  const body = `${studentName}${subjectText}${classText} registered from your pincode ${pincode}.`;

  const matchingTutors = tutors.filter(
    (t) => t.userId && activeTutorUserIds.has(String(t.userId))
  );

  await Promise.all(
    matchingTutors.map(async (t) => {
      const meta = {
        type: "student_pincode_match",
        studentProfileId: studentProfile._id,
        studentUserId,
        tutorProfileId: t._id,
        pincode,
      };
      await notificationService.createInApp(t.userId, title, body, meta);
      if (t.email) {
        await notificationService.sendEmail(t.email, title, body);
      }
    })
  );
}
                                                         
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
          hasPayoutDetails: hasTutorPayoutDetails(tutor),
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

    // â­ S3 path
    const existingProfile = await StudentProfile.findOne({ userId }).lean();
    const wasProfileComplete = Boolean(user.isProfileComplete);
    const previousPincode = String(existingProfile?.pincode || "").trim();
    let photoUrl = null;
    if (req.files?.photo) {
      photoUrl = req.files.photo[0].location; // <-- AWS S3 URL
    }

      const b = req.body;
      const resolveOther = (value, other) => {
        if (value === "Other" && String(other || "").trim()) {
          return String(other).trim();
        }
        return value;
      };
    const resolvedPhotoUrl = photoUrl || existingProfile?.photoUrl || "";
      const resolvedGender = resolveOther(b.gender || "", b.genderOther);
      const resolvedBoard = resolveOther(b.board || "", b.boardOther);
      const resolvedClassLevel = resolveOther(b.classLevel || "", b.classLevelOther);
      const resolvedStream = resolveOther(b.stream || "", b.streamOther);
      const resolvedProgram = resolveOther(b.program || "", b.programOther);
      const resolvedDiscipline = resolveOther(b.discipline || "", b.disciplineOther);
      const resolvedYearSem = resolveOther(b.yearSem || "", b.yearSemOther);
      const resolvedExam = resolveOther(b.exam || "", b.examOther);
      const resolvedTargetYear = resolveOther(b.targetYear || "", b.targetYearOther);
      const resolvedTutorGenderPref = resolveOther(
        b.tutorGenderPref || "",
        b.tutorGenderOther
      );
      const subjectsForProfile = normalizeArray(b.subjects);
      const subjectTimeSlots = normalizeSubjectTimeSlots(b.subjectTimeSlots)
        .filter((item) => subjectsForProfile.includes(item.subject))
        .map((item) => ({
          subject: item.subject,
          slots: Array.from(new Set(normalizeArray(item.slots))),
        }))
        .filter((item) => item.slots.length);
      const derivedPreferredTimes = subjectTimeSlots.length
        ? Array.from(new Set(subjectTimeSlots.flatMap((item) => item.slots)))
        : normalizeArray(b.preferredTimes);

      const profileData = {
        userId,
        name: b.name,
        email: b.email,
        altPhone: b.altPhone || "",
        gender: resolvedGender || "",
        genderOther: resolvedGender === "Other" ? b.genderOther || "" : "",
        addressLine1: b.addressLine1 || "",
        addressLine2:
          typeof b.addressLine2 === "undefined"
            ? existingProfile?.addressLine2 || ""
            : b.addressLine2 || "",
        city: b.city || "",
        state: b.state || "",
        pincode: b.pincode || "",
        learningMode: b.learningMode || "",
        track: b.track || "",
        board: resolvedBoard || "",
        boardOther: resolvedBoard === "Other" ? b.boardOther || "" : "",
        classLevel: resolvedClassLevel || "",
        classLevelOther:
          resolvedClassLevel === "Other" ? b.classLevelOther || "" : "",
        stream: resolvedStream || "",
        streamOther: resolvedStream === "Other" ? b.streamOther || "" : "",
        program: resolvedProgram || "",
        programOther: resolvedProgram === "Other" ? b.programOther || "" : "",
        discipline: resolvedDiscipline || "",
        disciplineOther:
          resolvedDiscipline === "Other" ? b.disciplineOther || "" : "",
        yearSem: resolvedYearSem || "",
        yearSemOther: resolvedYearSem === "Other" ? b.yearSemOther || "" : "",
        exam: resolvedExam || "",
        examOther: resolvedExam === "Other" ? b.examOther || "" : "",
        targetYear: resolvedTargetYear || "",
        targetYearOther:
          resolvedTargetYear === "Other" ? b.targetYearOther || "" : "",
        subjects: subjectsForProfile,
        tutorGenderPref: resolvedTutorGenderPref || "No Preference",
        tutorGenderOther:
          resolvedTutorGenderPref === "Other" ? b.tutorGenderOther || "" : "",
      preferredTimes: derivedPreferredTimes,
      subjectTimeSlots,
      availability: normalizeArray(b.availability),
      budget:
        typeof b.budget === "undefined"
          ? existingProfile?.budget || ""
          : b.budget || "",
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

    const currentPincode = String(profile?.pincode || "").trim();
    const shouldNotifyTutors =
      isComplete &&
      currentPincode &&
      (!wasProfileComplete || !existingProfile || previousPincode !== currentPincode);

    if (shouldNotifyTutors) {
      try {
        await notifyTutorsForStudentPincode(profile, userId);
      } catch (e) {
        console.warn("Student pincode tutor notification failed:", e.message);
      }
    }

    // Notify Admin
    try {
      await createAdminNotification(
        "Student Profile Updated",
        `Student ${profile.name || profile._id} updated their profile`,
        {
          studentId: profile._id,
          userId: userId,
          isProfileComplete: isComplete,
        }
      );
    } catch (e) {
      console.warn("Student profile update admin notification failed:", e.message);
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
    tutor.kycDocumentsStatus = "submitted";
    tutor.kycRejectionReason = "";
    tutor.kycStatus = getCombinedTutorKycStatus(tutor);

    await tutor.save();

    // Notify Admin
    try {
      await createAdminNotification(
        "Tutor KYC Submitted",
        `Tutor ${tutor.name || tutor._id} submitted KYC documents for verification`,
        {
          tutorId: tutor._id,
          userId: userId,
          kycStatus: tutor.kycStatus,
          kycDocumentsStatus: tutor.kycDocumentsStatus,
          payoutDetailsStatus: tutor.payoutDetailsStatus || "pending",
        }
      );
    } catch (e) {
      console.warn("KYC admin notification failed:", e.message);
    }

    res.status(200).json({
      success: true,
      message: hasTutorPayoutDetails(tutor)
        ? "KYC documents submitted successfully"
        : "KYC documents saved. Add payout details to submit KYC for review",
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
      addressLine1,
      city,
      state,
      pincode,
      altPhone,
    } = req.body;

    const existingProfile = await TutorProfile.findOne({ userId }).lean();

    // â­ AWS S3 returns file.location
    let photoUrl = null,
      resumeUrl = null;

    if (req.files?.photo)
      photoUrl = req.files.photo[0].location;

    if (req.files?.resume)
      resumeUrl = req.files.resume[0].location;

    const uploadedAadhaarUrls = req.files?.aadhaar
      ? req.files.aadhaar.map((file) => file.location).filter(Boolean)
      : [];
    const uploadedPanUrl = req.files?.pan?.[0]?.location || null;
    const hasUploadedGovProof = uploadedAadhaarUrls.length > 0 || Boolean(uploadedPanUrl);

      const parsedGroupSizes = normalizeArray(groupSizes);
      const sanitizeOther = (arr) => {
        if (!Array.isArray(arr)) return arr;
        if (arr.includes("Other") && arr.length > 1) {
          return arr.filter((v) => v !== "Other");
        }
        return arr;
      };
    const resolvedPhotoUrl = photoUrl || existingProfile?.photoUrl || "";
    const resolvedResumeUrl = resumeUrl || existingProfile?.resumeUrl || "";
    const resolvedAadhaarUrls = uploadedAadhaarUrls.length
      ? uploadedAadhaarUrls
      : existingProfile?.aadhaarUrls || [];
    const resolvedPanUrl = uploadedPanUrl || existingProfile?.panUrl || "";
    const resolvedIsAgeConfirmed =
      typeof isAgeConfirmed === "undefined"
        ? Boolean(existingProfile?.isAgeConfirmed)
        : String(isAgeConfirmed) === "true" || isAgeConfirmed === true;
      const normalizedSubjects = sanitizeOther(normalizeArray(subjects));
      const normalizedBoards = sanitizeOther(normalizeArray(boards));
      const normalizedClassLevels = normalizeArray(classLevels);
      const normalizedExams = normalizeArray(exams);
      const normalizedStudentTypes = normalizeArray(studentTypes);
      const normalizedAvailability = normalizeArray(availability);

    const profileData = {
      userId,
      name,
      email,
      gender,
      qualification,
      specialization,
      experience: Number(experience) || 0,
      subjects: normalizedSubjects,
      classLevels: normalizedClassLevels,
      boards: normalizedBoards,
      exams: normalizedExams,
      studentTypes: normalizedStudentTypes,
      groupSize: groupSize || parsedGroupSizes[0] || "",
      groupSizes: parsedGroupSizes,
      teachingMode,
      hourlyRate: parseFloat(hourlyRate) || 0,
      monthlyRate: parseFloat(monthlyRate) || 0,
      availability: normalizedAvailability,
      altPhone: altPhone || existingProfile?.altPhone || "",
      bio,
      isAgeConfirmed: resolvedIsAgeConfirmed,
      addressLine1,
      addressLine2:
        typeof req.body.addressLine2 === "undefined"
          ? existingProfile?.addressLine2 || ""
          : req.body.addressLine2 || "",
      city,
      state,
      pincode,
      ...(resolvedPhotoUrl && { photoUrl: resolvedPhotoUrl }),
      ...(resolvedResumeUrl && { resumeUrl: resolvedResumeUrl }),
      ...(resolvedAadhaarUrls.length && { aadhaarUrls: resolvedAadhaarUrls }),
      ...(resolvedPanUrl && { panUrl: resolvedPanUrl }),
      ...(hasUploadedGovProof && {
        kycDocumentsStatus: "submitted",
        kycRejectionReason: "",
      }),
    };

    const validationPayload = {
      ...profileData,
      photoUrl: resolvedPhotoUrl,
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

    if (hasUploadedGovProof) {
      profile.kycStatus = getCombinedTutorKycStatus(profile);
      await profile.save();
    }

    const safeProfile = profile?.toObject ? profile.toObject() : profile || {};
    const isComplete = isTutorProfileComplete(safeProfile);
    if (user.isProfileComplete !== isComplete) {
      user.isProfileComplete = isComplete;
      await user.save();
    }

    // Notify Admin
    try {
      await createAdminNotification(
        "Tutor Profile Updated",
        `Tutor ${profile.name || profile._id} updated their profile`,
        {
          tutorId: profile._id,
          userId: userId,
          isProfileComplete: isComplete,
        }
      );
    } catch (e) {
      console.warn("Tutor profile update admin notification failed:", e.message);
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
   UPDATE STUDENT PAYOUT DETAILS
------------------------------------------------------------ */
const updateStudentPayoutDetails = async (req, res) => {
  try {
    const userId = req.user.id;
    const user = await User.findById(userId).select("role isProfileComplete");

    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }
    if (user.role !== "student") {
      return res.status(403).json({
        success: false,
        message: "Only students can update payout details",
      });
    }
    if (!user.isProfileComplete) {
      return res.status(400).json({
        success: false,
        message: "Complete student profile before adding payout details",
      });
    }

    const upiId = String(req.body?.upiId || "").trim();
    const accountHolderName = String(req.body?.accountHolderName || "").trim();
    const bankAccountNumber = String(req.body?.bankAccountNumber || "").trim();
    const ifsc = String(req.body?.ifsc || "").trim().toUpperCase();

    if (!upiId || !UPI_REGEX.test(upiId)) {
      return res.status(400).json({
        success: false,
        message: "Valid UPI ID is required",
      });
    }
    if (!accountHolderName || accountHolderName.length < 2) {
      return res.status(400).json({
        success: false,
        message: "Account holder name is required",
      });
    }
    if (!bankAccountNumber || !BANK_ACCOUNT_REGEX.test(bankAccountNumber)) {
      return res.status(400).json({
        success: false,
        message: "Valid bank account number is required",
      });
    }
    if (!ifsc || !IFSC_REGEX.test(ifsc)) {
      return res.status(400).json({
        success: false,
        message: "Valid IFSC is required",
      });
    }

    const profile = await StudentProfile.findOneAndUpdate(
      { userId },
      {
        $set: {
          upiId,
          accountHolderName,
          bankAccountNumber,
          ifsc,
        },
      },
      { new: true }
    );

    if (!profile) {
      return res.status(404).json({
        success: false,
        message: "Student profile not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Payout details updated successfully",
      data: {
        upiId: profile.upiId || "",
        accountHolderName: profile.accountHolderName || "",
        bankAccountNumber: profile.bankAccountNumber || "",
        ifsc: profile.ifsc || "",
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Server error while updating payout details",
      error: error.message,
    });
  }
};

/* ------------------------------------------------------------
   UPDATE TUTOR PAYOUT DETAILS
------------------------------------------------------------ */
const updateTutorPayoutDetails = async (req, res) => {
  try {
    const userId = req.user.id;
    const user = await User.findById(userId).select("role isProfileComplete");

    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }
    if (user.role !== "tutor") {
      return res.status(403).json({
        success: false,
        message: "Only tutors can update payout details",
      });
    }
    if (!user.isProfileComplete) {
      return res.status(400).json({
        success: false,
        message: "Complete tutor profile before adding payout details",
      });
    }

    const upiId = String(req.body?.upiId || "").trim();
    const accountHolderName = String(req.body?.accountHolderName || "").trim();
    const bankAccountNumber = String(req.body?.bankAccountNumber || "").trim();
    const ifsc = String(req.body?.ifsc || "").trim().toUpperCase();

    if (!upiId || !UPI_REGEX.test(upiId)) {
      return res.status(400).json({
        success: false,
        message: "Valid UPI ID is required",
      });
    }
    if (!accountHolderName || accountHolderName.length < 2) {
      return res.status(400).json({
        success: false,
        message: "Account holder name is required",
      });
    }
    if (!bankAccountNumber || !BANK_ACCOUNT_REGEX.test(bankAccountNumber)) {
      return res.status(400).json({
        success: false,
        message: "Valid bank account number is required",
      });
    }
    if (!ifsc || !IFSC_REGEX.test(ifsc)) {
      return res.status(400).json({
        success: false,
        message: "Valid IFSC is required",
      });
    }

    const profile = await TutorProfile.findOneAndUpdate(
      { userId },
      {
        $set: {
          upiId,
          accountHolderName,
          bankAccountNumber,
          ifsc,
          payoutDetailsStatus: "submitted",
          kycRejectionReason: "",
        },
      },
      { new: true }
    );

    if (!profile) {
      return res.status(404).json({
        success: false,
        message: "Tutor profile not found",
      });
    }

    profile.kycStatus = getCombinedTutorKycStatus(profile);
    await profile.save();

    try {
      await createAdminNotification(
        "Tutor Payout Details Submitted",
        `Tutor ${profile.name || profile._id} submitted payout details for KYC review`,
        {
          tutorId: profile._id,
          userId,
          kycStatus: profile.kycStatus,
          payoutDetailsStatus: profile.payoutDetailsStatus,
        }
      );
    } catch (e) {
      console.warn("Tutor payout admin notification failed:", e.message);
    }

    return res.status(200).json({
      success: true,
      message: hasTutorKycDocuments(profile)
        ? "Payout details submitted successfully"
        : "Payout details saved. Upload KYC documents to submit for review",
      data: {
        upiId: profile.upiId || "",
        accountHolderName: profile.accountHolderName || "",
        bankAccountNumber: profile.bankAccountNumber || "",
        ifsc: profile.ifsc || "",
        payoutDetailsStatus: profile.payoutDetailsStatus || "pending",
        kycStatus: profile.kycStatus || "pending",
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Server error while updating payout details",
      error: error.message,
    });
  }
};

/* ------------------------------------------------------------
   GET ALL USERS
------------------------------------------------------------ */
const getAllUsers = async (req, res) => {
  try {
    const users = await User.find({ isDeleted: { $ne: true } }).select("-password -refreshToken");
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
  updateStudentPayoutDetails,
  updateTutorProfile,
  updateTutorPayoutDetails,
  getAllUsers,
  uploadTutorKyc,
  getStudentProfileForTutor
};
