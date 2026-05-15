const User = require("../models/User");
const StudentProfile = require("../models/StudentProfile");
const TutorProfile = require("../models/TutorProfile");
const Session = require("../models/Session");
const Payment = require("../models/Payment");
const AdminWallet = require("../models/AdminWallet");
const RegularClass = require("../models/RegularClass");
const Booking = require("../models/Booking");
const GroupBatch = require("../models/GroupBatch");
const DeviceToken = require("../models/DeviceToken");
const Notification = require("../models/Notification");
const Wallet = require("../models/Wallet");
const mongoose = require("mongoose");
const fs = require("fs");
const path = require("path");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { logActivity } = require("../services/loggerService");
const {
  DEFAULT_SESSION_DURATION_MINUTES,
  computeDurationMinutes,
} = require("../utils/sessionZoomUtils");

// S3 config (support multiple env names)
const S3_BUCKET = process.env.AWS_S3_BUCKET || process.env.AWS_BUCKET;
const S3_REGION = process.env.AWS_REGION;
const S3_ACCESS_KEY_ID =
  process.env.AWS_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY;
const S3_SECRET_ACCESS_KEY =
  process.env.AWS_SECRET_ACCESS_KEY || process.env.AWS_SECRET_KEY;
const useS3 = Boolean(
  S3_BUCKET && S3_REGION && S3_ACCESS_KEY_ID && S3_SECRET_ACCESS_KEY,
);
const s3 = useS3
  ? new S3Client({
      region: S3_REGION,
      credentials: {
        accessKeyId: S3_ACCESS_KEY_ID,
        secretAccessKey: S3_SECRET_ACCESS_KEY,
      },
    })
  : null;

function guessContentType(filename) {
  const ext = String(filename).toLowerCase();
  if (ext.endsWith(".png")) return "image/png";
  if (ext.endsWith(".jpg") || ext.endsWith(".jpeg")) return "image/jpeg";
  if (ext.endsWith(".gif")) return "image/gif";
  if (ext.endsWith(".svg")) return "image/svg+xml";
  if (ext.endsWith(".pdf")) return "application/pdf";
  if (ext.endsWith(".mp4")) return "video/mp4";
  if (ext.endsWith(".webm")) return "video/webm";
  if (ext.endsWith(".mov")) return "video/quicktime";
  return "application/octet-stream";
}

function extractLocalPath(url) {
  if (!url) return null;
  const str = String(url);
  const idx = str.indexOf("/uploads/");
  if (idx === -1) return null;
  const rel = str.substring(idx + 1); // 'uploads/...'
  const base = path.basename(rel);
  const p1 = path.join(process.cwd(), "uploads", base);
  const p2 = path.join(__dirname, "..", "uploads", base);
  if (fs.existsSync(p1)) return p1;
  if (fs.existsSync(p2)) return p2;
  return null;
}

async function putS3(buffer, key, contentType) {
  await s3.send(
    new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: contentType,
      ACL: "public-read",
    }),
  );
  return `https://${S3_BUCKET}.s3.${S3_REGION}.amazonaws.com/${key}`;
}

async function migrateField(doc, field, updates) {
  const url = doc[field];
  if (!url) return false;
  if (/s3\.amazonaws\.com\//i.test(String(url))) return false;
  const localPath = extractLocalPath(url);
  if (!localPath) return false;
  const buffer = fs.readFileSync(localPath);
  const base = path.basename(localPath);
  const key = `uploads/migrated/${base}`;
  const ct = guessContentType(base);
  const s3Url = await putS3(buffer, key, ct);
  updates[field] = s3Url;
  // add corresponding key fields where applicable
  if (field === "pdfUrl") updates["pdfKey"] = key;
  return true;
}

async function migrateArrayField(doc, field, updates) {
  const arr = Array.isArray(doc[field]) ? doc[field] : [];
  if (!arr.length) return false;
  const migrated = [];
  for (const url of arr) {
    if (/s3\.amazonaws\.com\//i.test(String(url))) {
      migrated.push(url);
      continue;
    }
    const localPath = extractLocalPath(url);
    if (!localPath) {
      migrated.push(url);
      continue;
    }
    const buffer = fs.readFileSync(localPath);
    const base = path.basename(localPath);
    const key = `uploads/migrated/${base}`;
    const ct = guessContentType(base);
    const s3Url = await putS3(buffer, key, ct);
    migrated.push(s3Url);
  }
  updates[field] = migrated;
  if (field === "previewImageUrls")
    updates["previewImageKeys"] = migrated.map((u) => {
      const idx = String(u).indexOf("/uploads/migrated/");
      return idx !== -1 ? String(u).substring(idx + 1) : "";
    });
  return true;
}

const migrateUploadsToS3 = async (req, res) => {
  try {
    if (!useS3) {
      return res
        .status(400)
        .json({ success: false, message: "S3 env vars not configured" });
    }

    const result = {
      StudentProfile: 0,
      TutorProfile: 0,
      Session: 0,
      Note: 0,
      missing: 0,
    };

    // StudentProfile: photoUrl
    const sps = await StudentProfile.find({
      photoUrl: { $exists: true, $ne: null },
    });
    for (const sp of sps) {
      const updates = {};
      const ok = await migrateField(sp, "photoUrl", updates);
      if (ok) {
        await StudentProfile.updateOne({ _id: sp._id }, { $set: updates });
        result.StudentProfile++;
      } else if (!/s3\.amazonaws\.com\//.test(String(sp.photoUrl))) {
        result.missing++;
      }
    }

    // TutorProfile: photoUrl, resumeUrl, demoVideoUrl, aadhaarUrls, panUrl
    const tps = await TutorProfile.find({});
    for (const tp of tps) {
      const updates = {};
      await migrateField(tp, "photoUrl", updates);
      await migrateField(tp, "resumeUrl", updates);
      await migrateField(tp, "demoVideoUrl", updates);
      await migrateArrayField(tp, "aadhaarUrls", updates);
      await migrateField(tp, "panUrl", updates);
      if (Object.keys(updates).length) {
        await TutorProfile.updateOne({ _id: tp._id }, { $set: updates });
        result.TutorProfile++;
      }
    }

    // Session: recordingUrl, notesUrl, assignmentUrl
    const sess = await Session.find({});
    for (const s of sess) {
      const updates = {};
      await migrateField(s, "recordingUrl", updates);
      await migrateField(s, "notesUrl", updates);
      await migrateField(s, "assignmentUrl", updates);
      if (Object.keys(updates).length) {
        await Session.updateOne({ _id: s._id }, { $set: updates });
        result.Session++;
      }
    }

    // Note: pdfUrl, previewImageUrls
    const Note = require("../models/Note");
    const notes = await Note.find({});
    for (const n of notes) {
      const updates = {};
      await migrateField(n, "pdfUrl", updates);
      await migrateArrayField(n, "previewImageUrls", updates);
      if (Object.keys(updates).length) {
        await Note.updateOne({ _id: n._id }, { $set: updates });
        result.Note++;
      }
    }

    return res.json({ success: true, message: "Migration completed", result });
  } catch (err) {
    console.error("migrateUploadsToS3 error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Server error", error: err.message });
  }
};

// Get all users with pagination + filters + search + referral fields
const getAllUsers = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      role,
      status,
      q,
      sort = "createdAt_desc",
    } = req.query;
    const pageNum = Math.max(1, Number(page));
    const limitNum = Math.max(1, Math.min(200, Number(limit)));
    const skip = Math.max(0, (pageNum - 1) * limitNum);

    const andClauses = [];
    andClauses.push({ isDeleted: { $ne: true } });
    if (role && ["student", "tutor", "admin"].includes(String(role)))
      andClauses.push({ role: role });
    if (status && ["active", "inactive", "suspended"].includes(String(status)))
      andClauses.push({ status: status });

    if (q && String(q).trim()) {
      const regex = new RegExp(String(q).trim(), "i");
      const sp = await StudentProfile.find({
        $or: [{ name: regex }, { email: regex }],
      })
        .select("userId")
        .lean();
      const tp = await TutorProfile.find({
        $or: [{ name: regex }, { email: regex }],
      })
        .select("userId")
        .lean();
      const profileUserIds = [
        ...sp.map((x) => x.userId).filter(Boolean),
        ...tp.map((x) => x.userId).filter(Boolean),
      ].map((id) => new mongoose.Types.ObjectId(String(id)));
      const orClauses = [];
      if (profileUserIds.length)
        orClauses.push({ _id: { $in: profileUserIds } });
      orClauses.push({ phone: regex });
      orClauses.push({ email: regex });
      andClauses.push({ $or: orClauses });
    }

    const filter = andClauses.length ? { $and: andClauses } : {};

    let sortSpec = { createdAt: -1 };
    if (sort === "createdAt_asc") sortSpec = { createdAt: 1 };
    else if (sort === "lastActive_desc") sortSpec = { lastLogin: -1 };
    else if (sort === "lastActive_asc") sortSpec = { lastLogin: 1 };

    const total = await User.countDocuments(filter);
    const users = await User.find(filter)
      .select("-password -refreshToken")
      .sort(sortSpec)
      .skip(skip)
      .limit(limitNum)
      .lean();

    const userIds = users.map((u) => u._id);
    const [studentProfiles, tutorProfiles] = await Promise.all([
      StudentProfile.find({ userId: { $in: userIds } }).lean(),
      TutorProfile.find({ userId: { $in: userIds } }).lean(),
    ]);
    const studentMap = new Map(
      studentProfiles.map((p) => [p.userId.toString(), p]),
    );
    const tutorMap = new Map(
      tutorProfiles.map((p) => [p.userId.toString(), p]),
    );

    // Referral: own code and used code
    let codeMap = new Map();
    try {
      const ReferralCode = require("../models/ReferralCode");
      const codes = await ReferralCode.find({ ownerUserId: { $in: userIds } })
        .select("ownerUserId code")
        .lean();
      codeMap = new Map(codes.map((c) => [c.ownerUserId.toString(), c.code]));
    } catch (_) {}

    // Referrer resolution for display
    const referrerIds = users
      .map((u) => u.referrerUserId)
      .filter(Boolean)
      .map((id) => id.toString());
    let refRoleMap = new Map();
    let refTutorNameMap = new Map();
    let refStudentNameMap = new Map();
    if (referrerIds.length) {
      const refUsers = await User.find({ _id: { $in: referrerIds } })
        .select("_id role")
        .lean();
      refRoleMap = new Map(refUsers.map((ru) => [ru._id.toString(), ru.role]));
      const refTutorProfiles = await TutorProfile.find({
        userId: { $in: referrerIds },
      })
        .select("userId name")
        .lean();
      refTutorNameMap = new Map(
        refTutorProfiles.map((p) => [p.userId.toString(), p.name]),
      );
      const StudentProfile = require("../models/StudentProfile");
      const refStudentProfiles = await StudentProfile.find({
        userId: { $in: referrerIds },
      })
        .select("userId name")
        .lean();
      refStudentNameMap = new Map(
        refStudentProfiles.map((p) => [p.userId.toString(), p.name]),
      );
    }

    const baseUrl = (process.env.BASE_URL || "").replace(/\/$/, "");
    const mergedUsers = users.map((u) => {
      let profile = null;
      let name = null;
      let email = null;
      let photoUrl = null;
      if (u.role === "student" && studentMap.has(u._id.toString())) {
        profile = studentMap.get(u._id.toString());
      } else if (u.role === "tutor" && tutorMap.has(u._id.toString())) {
        profile = tutorMap.get(u._id.toString());
      }
      if (profile) {
        name = profile.name || null;
        email = profile.email || u.email || null;
        if (profile.photoUrl) {
          photoUrl = /^https?:\/\//i.test(profile.photoUrl)
            ? profile.photoUrl
            : baseUrl
              ? `${baseUrl}/${String(profile.photoUrl).replace(/^\//, "")}`
              : String(profile.photoUrl);
        }
      } else {
        email = u.email || null;
      }
      const profilePhone =
        (u.role === 'student'
          ? profile?.altPhone
          : profile?.phone) ||
        u.phone ||
        null;
      return {
        _id: u._id,
        name,
        email,
        phone: profilePhone,
        profilePhone,
        gender: profile?.gender || null,
        genderOther: profile?.genderOther || null,
        addressLine1: profile?.addressLine1 || null,
        addressLine2: profile?.addressLine2 || null,
        city: profile?.city || null,
        state: profile?.state || null,
        pincode: profile?.pincode || null,
        learningMode: profile?.learningMode || profile?.teachingMode || null,
        track: profile?.track || null,
        board: profile?.board || profile?.boards || null,
        boardOther: profile?.boardOther || null,
        classLevel: profile?.classLevel || profile?.classLevels || null,
        classLevelOther: profile?.classLevelOther || null,
        stream: profile?.stream || null,
        streamOther: profile?.streamOther || null,
        program: profile?.program || null,
        programOther: profile?.programOther || null,
        discipline: profile?.discipline || null,
        disciplineOther: profile?.disciplineOther || null,
        yearSem: profile?.yearSem || null,
        yearSemOther: profile?.yearSemOther || null,
        exam: profile?.exam || profile?.exams || null,
        examOther: profile?.examOther || null,
        targetYear: profile?.targetYear || null,
        targetYearOther: profile?.targetYearOther || null,
        subjects: profile?.subjects || [],
        subjectOther: profile?.subjectOther || null,
        tutorGenderPref: profile?.tutorGenderPref || null,
        tutorGenderOther: profile?.tutorGenderOther || null,
        preferredTimes: profile?.preferredTimes || [],
        budget: profile?.budget || null,
        goals: profile?.goals || null,
        availability: profile?.availability || [],
        upiId: profile?.upiId || null,
        accountHolderName: profile?.accountHolderName || null,
        bankAccountNumber: profile?.bankAccountNumber || null,
        ifsc: profile?.ifsc || null,
        role: u.role,
        status: u.status,
        isProfileComplete: u.isProfileComplete,
        lastLogin: u.lastLogin,
        createdAt: u.createdAt,
        profilePhoto: photoUrl,
        referralCode: codeMap.get(u._id.toString()) || null,
        referralCodeUsed: u.referralCodeUsed || null,
        referrerUserId: u.referrerUserId || null,
        referrerName:
          (u.referrerUserId &&
            (refTutorNameMap.get(u.referrerUserId.toString()) ||
              refStudentNameMap.get(u.referrerUserId.toString()))) ||
          null,
        referrerRole:
          (u.referrerUserId && refRoleMap.get(u.referrerUserId.toString())) ||
          null,
      };
    });

    res.status(200).json({
      success: true,
      data: {
        users: mergedUsers,
        pagination: {
          total,
          page: pageNum,
          limit: limitNum,
          pages: Math.ceil(total / limitNum),
        },
      },
    });
  } catch (error) {
    console.error("Get All Users Error:", error);
    res
      .status(500)
      .json({ success: false, message: "Server error", error: error.message });
  }
};

// Get user details by ID
const getUserById = async (req, res) => {
  try {
    const { userId } = req.params;

    const user = await User.findById(userId).select("-refreshToken");

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    let profile;
    let roleDetails = {};
    let referralCodeStr = null;
    const userObj = user.toObject ? user.toObject() : user;

    if (user.role === "student") {
      profile = await StudentProfile.findOne({ userId }).lean();
    } else if (user.role === "tutor") {
      profile = await TutorProfile.findOne({ userId }).lean();
      if (profile) {
        roleDetails = {
          kycStatus: profile.kycStatus || "pending",
          hasKyc: !!(profile.aadhaarUrls?.length || profile.panUrl),
          isVerified: profile.status === "approved",
        };
      }
    }

    try {
      const ReferralCode = require("../models/ReferralCode");
      const mine = await ReferralCode.findOne({ ownerUserId: userId }).lean();
      referralCodeStr = mine?.code || null;
    } catch (_) {}

    res.status(200).json({
      success: true,
      data: {
        user: { ...userObj, id: user._id },
        profile: profile || null,
        referralCode: referralCodeStr,
        roleDetails,
      },
    });
  } catch (error) {
    console.error("Get User By ID Error:", error);
    res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
};

// Verify tutor
const verifyTutor = async (req, res) => {
  try {
    const { tutorId } = req.params;
    const { isVerified } = req.body;

    if (isVerified === undefined) {
      return res.status(400).json({
        success: false,
        message: "isVerified field is required",
      });
    }

    const tutorProfile = await TutorProfile.findOne({ userId: tutorId });

    if (!tutorProfile) {
      return res.status(404).json({
        success: false,
        message: "Tutor profile not found",
      });
    }

    tutorProfile.isVerified = isVerified;
    await tutorProfile.save();

    res.status(200).json({
      success: true,
      message: `Tutor ${isVerified ? "verified" : "unverified"} successfully`,
      data: {
        tutorId,
        isVerified,
      },
    });
  } catch (error) {
    console.error("Verify Tutor Error:", error);
    res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
};

const updateUserStatus = async (req, res) => {
  try {
    const userId = req.params.id;
    const { status } = req.body;

    if (!["active", "inactive", "suspended"].includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Invalid status value. Use active, inactive or suspended.",
      });
    }

    const user = await User.findByIdAndUpdate(
      userId,
      { status },
      { new: true },
    ).select("-password -refreshToken");

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    if (status === "suspended" && user.role === "student") {
      try {
        const sp = await StudentProfile.findOne({ userId }).select("_id").lean();
        const spId = sp?._id;
        if (spId) {
          const now = new Date();
          await Promise.all([
            GroupBatch.updateMany(
              {
                $or: [
                  { enrolled: spId },
                  { "enrollmentDetails.studentId": spId },
                  { "holds.studentId": spId },
                  { waitlist: spId },
                ],
              },
              {
                $pull: {
                  enrolled: spId,
                  waitlist: spId,
                  enrollmentDetails: { studentId: spId },
                  holds: { studentId: spId },
                },
              },
            ),
            RegularClass.updateMany(
              { studentId: spId, status: { $ne: "ended" } },
              { $set: { status: "paused" } },
            ),
            Session.updateMany(
              { studentId: spId, startDateTime: { $gte: now }, status: "scheduled" },
              { $set: { status: "cancelled" } },
            ),
          ]);
        }
      } catch (_) {}
    }

    await logActivity(req, "ADMIN_UPDATE_USER_STATUS", {
      targetUserId: userId,
      newStatus: status,
    });

    res.status(200).json({
      success: true,
      message: `User ${status === "active" ? "activated" : "deactivated"} successfully`,
      user,
    });
  } catch (error) {
    console.error("Update User Status Error:", error);
    res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
};

const getDashboardStats = async (req, res) => {
  try {
    const totalUsers = await User.countDocuments();
    const students = await User.countDocuments({ role: "student" });
    const tutors = await User.countDocuments({ role: "tutor" });
    const admins = await User.countDocuments({ role: "admin" });

    const activeUsers = await User.countDocuments({ status: "active" });
    const inactiveUsers = await User.countDocuments({ status: "inactive" });

    const kycApproved = await TutorProfile.countDocuments({
      kycStatus: "approved",
    });
    const kycPending = await TutorProfile.countDocuments({
      kycStatus: "pending",
    });
    const kycRejected = await TutorProfile.countDocuments({
      kycStatus: "rejected",
    });

    const sessionsScheduled = await Session.countDocuments({
      status: "scheduled",
    });
    const sessionsCompleted = await Session.countDocuments({
      status: "completed",
    });
    const upcoming7d = await Session.countDocuments({
      startDateTime: {
        $gte: new Date(),
        $lte: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });

    const subsPaidAgg = await Payment.aggregate([
      { $match: { type: "subscription", status: "paid" } },
      { $group: { _id: null, total: { $sum: "$amount" }, count: { $sum: 1 } } },
    ]);
    const notesPaidAgg = await Payment.aggregate([
      { $match: { type: "note", status: "paid" } },
      { $group: { _id: null, total: { $sum: "$amount" }, count: { $sum: 1 } } },
    ]);
    const payoutsAgg = await Payment.aggregate([
      { $match: { type: "payout" } },
      {
        $group: {
          _id: null,
          created: { $sum: { $cond: [{ $eq: ["$status", "created"] }, 1, 0] } },
          settled: { $sum: { $cond: [{ $eq: ["$status", "settled"] }, 1, 0] } },
          commissionTotal: { $sum: "$commissionAmount" },
          amountTotal: { $sum: "$amount" },
        },
      },
    ]);

    const adminWallet = await AdminWallet.findOne();

    const stats = {
      users: {
        total: totalUsers,
        students,
        tutors,
        admins,
        active: activeUsers,
        inactive: inactiveUsers,
      },
      kyc: {
        approved: kycApproved,
        pending: kycPending,
        rejected: kycRejected,
      },
      sessions: {
        scheduled: sessionsScheduled,
        completed: sessionsCompleted,
        upcoming7d,
      },
      payments: {
        subscriptions: {
          totalAmount: subsPaidAgg[0]?.total || 0,
          count: subsPaidAgg[0]?.count || 0,
        },
        notes: {
          totalAmount: notesPaidAgg[0]?.total || 0,
          count: notesPaidAgg[0]?.count || 0,
        },
        payouts: {
          created: payoutsAgg[0]?.created || 0,
          settled: payoutsAgg[0]?.settled || 0,
          commissionTotal: payoutsAgg[0]?.commissionTotal || 0,
          amountTotal: payoutsAgg[0]?.amountTotal || 0,
        },
      },
      adminWallet: adminWallet
        ? {
            balance: adminWallet.balance || 0,
            holdAmount: adminWallet.holdAmount || 0,
          }
        : { balance: 0, holdAmount: 0 },
    };

    res.status(200).json({ success: true, stats });
  } catch (error) {
    res
      .status(500)
      .json({ success: false, message: "Server error", error: error.message });
  }
};

const getDashboardActivity = async (req, res) => {
  try {
    const limitRaw = Number(req.query.limit || 6);
    const limit = Math.max(
      1,
      Math.min(20, Number.isFinite(limitRaw) ? limitRaw : 6),
    );

    const recentUsers = await User.find()
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    const userIds = recentUsers.map((u) => u._id).filter(Boolean);
    const [studentProfiles, tutorProfiles] = await Promise.all([
      StudentProfile.find({ userId: { $in: userIds } })
        .select("userId name")
        .lean(),
      TutorProfile.find({ userId: { $in: userIds } })
        .select("userId name")
        .lean(),
    ]);
    const studentNameByUserId = new Map(
      studentProfiles.map((p) => [String(p.userId), p.name]),
    );
    const tutorNameByUserId = new Map(
      tutorProfiles.map((p) => [String(p.userId), p.name]),
    );

    const signupEvents = recentUsers.map((u) => {
      const userId = String(u._id);
      const name =
        u.role === "student"
          ? studentNameByUserId.get(userId)
          : u.role === "tutor"
            ? tutorNameByUserId.get(userId)
            : null;
      return {
        id: `signup-${u._id}`,
        type: "signup",
        role: u.role,
        name: name || u.phone || "User",
        at: u.createdAt,
      };
    });

    const events = signupEvents
      .filter((ev) => ev.at)
      .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
      .slice(0, limit);

    res.status(200).json({ success: true, events });
  } catch (error) {
    res
      .status(500)
      .json({ success: false, message: "Server error", error: error.message });
  }
};

const listAdminSessions = async (req, res) => {
  try {
    const {
      status,
      from,
      to,
      page = 1,
      limit = 50,
      student,
      tutor,
    } = req.query;
    const pageNum = Math.max(1, Number(page));
    const limitNum = Math.max(1, Number(limit));
    const skip = Math.max(0, (pageNum - 1) * limitNum);

    if (status === "not-scheduled") {
      const rcFilter = { scheduleStatus: "not-scheduled" };
      if (student) {
        if (mongoose.isValidObjectId(student)) {
          const sp = await StudentProfile.findById(student)
            .select("userId")
            .lean();
          rcFilter.studentId =
            sp?.userId || new mongoose.Types.ObjectId(String(student));
        } else {
          const sps = await StudentProfile.find({
            name: new RegExp(String(student), "i"),
          })
            .select("userId")
            .lean();
          rcFilter.studentId = {
            $in: sps.map((x) => x.userId).filter(Boolean),
          };
        }
      }
      if (tutor) {
        if (mongoose.isValidObjectId(tutor)) {
          const tp = await TutorProfile.findById(tutor).select("userId").lean();
          rcFilter.tutorId =
            tp?.userId || new mongoose.Types.ObjectId(String(tutor));
        } else {
          const tps = await TutorProfile.find({
            name: new RegExp(String(tutor), "i"),
          })
            .select("userId")
            .lean();
          rcFilter.tutorId = { $in: tps.map((x) => x.userId).filter(Boolean) };
        }
      }

      const total = await RegularClass.countDocuments(rcFilter);
      const classes = await RegularClass.find(rcFilter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean();

      const studentIds = classes.map((c) => c.studentId).filter(Boolean);
      const tutorIds = classes.map((c) => c.tutorId).filter(Boolean);
      const [spList, tpList] = await Promise.all([
        StudentProfile.find({ userId: { $in: studentIds } })
          .select("name photoUrl userId")
          .lean(),
        TutorProfile.find({ userId: { $in: tutorIds } })
          .select("name photoUrl userId")
          .lean(),
      ]);
      const spMap = new Map(spList.map((s) => [String(s.userId), s]));
      const tpMap = new Map(tpList.map((t) => [String(t.userId), t]));

      const data = classes.map((c) => ({
        kind: "regularClass",
        _id: c._id,
        status: "not-scheduled",
        attendance: "not-marked",
        startDateTime: c.startDate,
        subject: c.subject,
        regularClassId: { subject: c.subject },
        studentId: spMap.get(String(c.studentId)) || null,
        tutorId: tpMap.get(String(c.tutorId)) || null,
      }));

      return res.status(200).json({
        success: true,
        data,
        pagination: {
          total,
          page: pageNum,
          limit: limitNum,
          pages: Math.ceil(total / limitNum),
        },
      });
    }

    const andClauses = [];
    if (status) andClauses.push({ status });
    if (from || to) {
      const range = {};
      if (from) range.$gte = new Date(from);
      if (to) range.$lte = new Date(to);
      andClauses.push({ startDateTime: range });
    }
    if (student) {
      if (mongoose.isValidObjectId(student)) {
        const sp = await StudentProfile.findById(student)
          .select("_id userId")
          .lean();
        const or = [];
        if (sp?._id) or.push({ studentId: sp._id });
        or.push({ studentId: new mongoose.Types.ObjectId(String(student)) });
        if (sp?.userId) or.push({ studentId: sp.userId });
        andClauses.push({ $or: or });
      } else {
        const sps = await StudentProfile.find({
          name: new RegExp(String(student), "i"),
        })
          .select("_id userId")
          .lean();
        const ids = sps.map((x) => x._id);
        const userIds = sps.map((x) => x.userId).filter(Boolean);
        andClauses.push({
          $or: [{ studentId: { $in: ids } }, { studentId: { $in: userIds } }],
        });
      }
    }
    if (tutor) {
      if (mongoose.isValidObjectId(tutor)) {
        const tp = await TutorProfile.findById(tutor)
          .select("_id userId")
          .lean();
        const or = [];
        if (tp?._id) or.push({ tutorId: tp._id });
        or.push({ tutorId: new mongoose.Types.ObjectId(String(tutor)) });
        if (tp?.userId) or.push({ tutorId: tp.userId });
        andClauses.push({ $or: or });
      } else {
        const tps = await TutorProfile.find({
          name: new RegExp(String(tutor), "i"),
        })
          .select("_id userId")
          .lean();
        const ids = tps.map((x) => x._id);
        const userIds = tps.map((x) => x.userId).filter(Boolean);
        andClauses.push({
          $or: [{ tutorId: { $in: ids } }, { tutorId: { $in: userIds } }],
        });
      }
    }
    const filter = andClauses.length ? { $and: andClauses } : {};

    const total = await Session.countDocuments(filter);
    const sessions = await Session.find(filter)
      .sort({ startDateTime: -1 })
      .skip(skip)
      .limit(limitNum)
      .populate({
        path: "regularClassId",
        select: "subject planType studentId tutorId scheduleStatus startDate",
      })
      .populate({ path: "studentId", select: "name photoUrl" })
      .populate({ path: "tutorId", select: "name photoUrl" })
      .lean();

    return res.status(200).json({
      success: true,
      data: sessions,
      pagination: {
        total,
        page: pageNum,
        limit: limitNum,
        pages: Math.ceil(total / limitNum),
      },
    });
  } catch (error) {
    return res
      .status(500)
      .json({ success: false, message: "Server error", error: error.message });
  }
};

const listAdminClassesMonitor = async (req, res) => {
  try {
    const {
      student,
      tutor,
      kind,
      status,
      isLive,
      from,
      to,
      page = 1,
      limit = 20,
    } = req.query;
    const now = new Date();
    const parseDateBoundary = (value, endOfDay = false) => {
      if (!value) return null;
      const raw = String(value).trim();
      if (!raw) return null;
      if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
        return new Date(`${raw}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`);
      }
      const d = new Date(raw);
      if (Number.isNaN(d.getTime())) return null;
      return d;
    };
    let windowStart = null;
    let windowEnd = null;
    if (from || to) {
      const f = parseDateBoundary(from, false);
      const t = parseDateBoundary(to, true);
      windowStart = f && !Number.isNaN(f.getTime()) ? f : null;
      windowEnd = t && !Number.isNaN(t.getTime()) ? t : null;
    }
    if (!windowStart || !windowEnd) {
      const y = now.getUTCFullYear();
      const m = String(now.getUTCMonth() + 1).padStart(2, "0");
      const d = String(now.getUTCDate()).padStart(2, "0");
      const start = new Date(`${y}-${m}-${d}T00:00:00.000Z`);
      const end = new Date(`${y}-${m}-${d}T23:59:59.999Z`);
      windowStart = windowStart || start;
      windowEnd = windowEnd || end;
    }

    const resolveStudentIds = async (value) => {
      if (!value) return [];
      const raw = String(value).trim();
      if (!raw) return [];
      if (mongoose.isValidObjectId(raw)) {
        const sp = await StudentProfile.findOne({
          $or: [{ _id: raw }, { userId: raw }],
        })
          .select("_id")
          .lean();
        return sp?._id ? [sp._id] : [new mongoose.Types.ObjectId(raw)];
      }
      const sps = await StudentProfile.find({
        name: new RegExp(raw, "i"),
      })
        .select("_id")
        .lean();
      return sps.map((x) => x._id);
    };

    const resolveTutorIds = async (value) => {
      if (!value) return [];
      const raw = String(value).trim();
      if (!raw) return [];
      if (mongoose.isValidObjectId(raw)) {
        const tp = await TutorProfile.findOne({
          $or: [{ _id: raw }, { userId: raw }],
        })
          .select("_id")
          .lean();
        return tp?._id ? [tp._id] : [new mongoose.Types.ObjectId(raw)];
      }
      const tps = await TutorProfile.find({
        name: new RegExp(raw, "i"),
      })
        .select("_id")
        .lean();
      return tps.map((x) => x._id);
    };

    const [studentIds, tutorIds] = await Promise.all([
      resolveStudentIds(student),
      resolveTutorIds(tutor),
    ]);

    const andClauses = [
      { startDateTime: { $gte: windowStart, $lte: windowEnd } },
    ];

    if (tutorIds.length) {
      andClauses.push({ tutorId: { $in: tutorIds } });
    }

    let batchIdsForStudent = [];
    if (studentIds.length) {
      const batches = await GroupBatch.find({
        enrolled: { $in: studentIds },
      })
        .select("_id")
        .lean();
      batchIdsForStudent = batches.map((b) => b._id);
      andClauses.push({
        $or: [
          { studentId: { $in: studentIds } },
          { groupBatchId: { $in: batchIdsForStudent } },
        ],
      });
    }

    if (kind === "group") {
      andClauses.push({ groupBatchId: { $exists: true, $ne: null } });
    } else if (kind === "regular") {
      andClauses.push({
        $and: [
          { regularClassId: { $exists: true, $ne: null } },
          { groupBatchId: { $in: [null, undefined] } },
        ],
      });
    }

    if (status) {
      andClauses.push({ status: String(status) });
    }

    const filter = andClauses.length ? { $and: andClauses } : {};
    const sessions = await Session.find(filter)
      .sort({ startDateTime: -1, _id: -1 })
      .populate({ path: "studentId", select: "name photoUrl" })
      .populate({ path: "tutorId", select: "name photoUrl userId" })
      .populate({ path: "regularClassId", select: "subject" })
      .populate({
        path: "groupBatchId",
        select: "subject batchType recurring enrolled tutorId",
      })
      .lean();

    if (!sessions.length) {
      return res.status(200).json({
        success: true,
        data: [],
        summary: { isInClass: false, count: 0, liveCount: 0 },
        pagination: {
          total: 0,
          page: Number(page) || 1,
          limit: Number(limit) || 20,
          pages: 0,
        },
      });
    }

    const batches = sessions
      .map((s) => s.groupBatchId)
      .filter(Boolean)
      .filter((b) => typeof b === "object" && b._id);
    const batchMap = new Map(
      batches.map((b) => [String(b._id), b]),
    );

    const enrolledIds = batches
      .flatMap((b) => b.enrolled || [])
      .map((id) => String(id));
    const uniqueEnrolledIds = [...new Set(enrolledIds)];
    const enrolledProfiles = uniqueEnrolledIds.length
      ? await StudentProfile.find({ _id: { $in: uniqueEnrolledIds } })
          .select("name photoUrl")
          .lean()
      : [];
    const enrolledMap = new Map(
      enrolledProfiles.map((p) => [String(p._id), p]),
    );

    const rows = sessions
      .map((s) => {
        const start = s.startDateTime ? new Date(s.startDateTime) : null;
        if (!start || Number.isNaN(start.getTime())) return null;

        let end = s.actualEndTime ? new Date(s.actualEndTime) : null;
        if (!end || Number.isNaN(end.getTime())) {
          const gb = s.groupBatchId ? batchMap.get(String(s.groupBatchId)) : null;
          if (gb?.recurring?.time && gb?.recurring?.endTime) {
            const minutes = computeDurationMinutes(
              gb.recurring.time,
              gb.recurring.endTime,
            );
            end = new Date(start.getTime() + minutes * 60 * 1000);
          } else {
            end = new Date(
              start.getTime() + DEFAULT_SESSION_DURATION_MINUTES * 60 * 1000,
            );
          }
        }

        const isLive = start <= now && now <= end;

        const gbId =
          s.groupBatchId && typeof s.groupBatchId === "object"
            ? s.groupBatchId._id
            : s.groupBatchId;
        const gb = gbId ? batchMap.get(String(gbId)) : null;
        const enrolled =
          gb?.enrolled?.map((id) => {
            const p = enrolledMap.get(String(id));
            return p ? { _id: id, name: p.name, photoUrl: p.photoUrl } : { _id: id };
          }) || [];

        const kindValue = gb ? "group" : "regular";
        const record = {
          _id: s._id,
          kind: kindValue,
          subject:
            gb?.subject ||
            s.regularClassId?.subject ||
            s.subject ||
            "Class",
          startDateTime: s.startDateTime,
          endDateTime: end,
          status: s.status,
          isLive,
          meetingLink: s.meetingLink || s.joinUrl || "",
          tutor: s.tutorId || null,
          student: s.studentId || null,
          groupBatchId: gbId || null,
          batchInfo: gb
            ? {
                subject: gb.subject,
                batchType: gb.batchType,
              }
            : null,
          enrolled,
          presence: {
            tutorJoined: !!s.tutorJoinTime,
            studentJoined: !!s.studentJoinTime,
            tutorJoinTime: s.tutorJoinTime || null,
            studentJoinTime: s.studentJoinTime || null,
          },
        };

        if (String(isLive || "").toLowerCase() === "true" && !record.isLive) {
          return null;
        }
        if (String(isLive || "").toLowerCase() === "false" && record.isLive) {
          return null;
        }

        return record;
      })
      .filter(Boolean);

    const sortedRows = rows
      .slice()
      .sort((a, b) => {
        const at = new Date(a.startDateTime).getTime();
        const bt = new Date(b.startDateTime).getTime();
        if (bt !== at) return bt - at;
        return String(b._id).localeCompare(String(a._id));
      });
    const liveRows = sortedRows.filter((r) => r.isLive);
    const filteredRows = sortedRows;

    const pageNum = Math.max(1, Number(page) || 1);
    const limitNum = Math.max(1, Math.min(200, Number(limit) || 20));
    const total = filteredRows.length;
    const pages = Math.ceil(total / limitNum);
    const startIdx = (pageNum - 1) * limitNum;
    const pageRows = filteredRows.slice(startIdx, startIdx + limitNum);

    return res.status(200).json({
      success: true,
      data: pageRows,
      summary: {
        isInClass: liveRows.length > 0,
        count: filteredRows.length,
        liveCount: liveRows.length,
      },
      pagination: {
        total,
        page: pageNum,
        limit: limitNum,
        pages,
      },
    });
  } catch (error) {
    return res
      .status(500)
      .json({ success: false, message: "Server error", error: error.message });
  }
};

const listAdminBookings = async (req, res) => {
  try {
    const { status, startDate, endDate, page = 1, limit = 50 } = req.query;
    const pageNum = Math.max(1, Number(page));
    const limitNum = Math.max(1, Number(limit));
    const skip = Math.max(0, (pageNum - 1) * limitNum);

    const andClauses = [{ type: "demo" }];
    if (status) andClauses.push({ status });
    if (startDate || endDate) {
      const range = {};
      if (startDate) range.$gte = new Date(startDate);
      if (endDate) range.$lte = new Date(endDate);
      andClauses.push({ preferredDate: range });
    }
    const filter = andClauses.length ? { $and: andClauses } : {};

    const total = await Booking.countDocuments(filter);
    const bookings = await Booking.find(filter)
      .sort({ preferredDate: -1, createdAt: -1 })
      .skip(skip)
      .limit(limitNum)
      .lean();

    if (!bookings.length) {
      return res.status(200).json({
        success: true,
        data: [],
        pagination: { total: 0, page: pageNum, limit: limitNum, pages: 0 },
      });
    }

    const studentUserIds = bookings.map((b) => b.studentId).filter(Boolean);
    const tutorUserIds = bookings.map((b) => b.tutorId).filter(Boolean);

    const [studentProfiles, tutorProfiles] = await Promise.all([
      StudentProfile.find({ userId: { $in: studentUserIds } })
        .select("userId name email")
        .lean(),
      TutorProfile.find({ userId: { $in: tutorUserIds } })
        .select("userId name email")
        .lean(),
    ]);

    const studentMap = new Map(
      studentProfiles.map((p) => [String(p.userId), p]),
    );
    const tutorMap = new Map(tutorProfiles.map((p) => [String(p.userId), p]));

    const data = bookings.map((b) => ({
      _id: b._id,
      status: b.status,
      subject: b.subject,
      preferredDate: b.preferredDate,
      preferredTime: b.preferredTime,
      meetingLink: b.joinUrl || b.meetingLink || "",
      joinUrl: b.joinUrl || "",
      startUrl: b.startUrl || "",
      meetingId: b.meetingId || "",
      meetingPassword: b.meetingPassword || "",
      student: studentMap.get(String(b.studentId)) || null,
      tutor: tutorMap.get(String(b.tutorId)) || null,
    }));

    return res.status(200).json({
      success: true,
      data,
      pagination: {
        total,
        page: pageNum,
        limit: limitNum,
        pages: Math.ceil(total / limitNum),
      },
    });
  } catch (error) {
    return res
      .status(500)
      .json({ success: false, message: "Server error", error: error.message });
  }
};

const deleteUser = async (req, res) => {
  try {
    const { userId } = req.params;

    const user = await User.findById(userId);
    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }

    if (user.isDeleted) {
      return res
        .status(400)
        .json({ success: false, message: "User is already deleted" });
    }

    user.isDeleted = true;
    user.deletedAt = new Date();
    user.status = "inactive";
    await user.save();

    await logActivity(req, "ADMIN_DELETE_USER", { targetUserId: userId });

    res
      .status(200)
      .json({ success: true, message: "User deleted successfully" });
  } catch (error) {
    console.error("Delete User Error:", error);
    res
      .status(500)
      .json({ success: false, message: "Server error", error: error.message });
  }
};

// Hard delete a user and their profile (student or tutor)
const hardDeleteUser = async (req, res) => {
  try {
    const { userId } = req.params;
    const user = await User.findById(userId);
    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }

    // Remove dependent documents that are safe to delete
    await Promise.allSettled([
      DeviceToken.deleteMany({ userId }),
      Notification.deleteMany({ userId }),
      Wallet.deleteOne({ userId }),
    ]);

    // Remove role-specific profile
    if (String(user.role) === "student") {
      await StudentProfile.deleteOne({ userId });
    } else if (String(user.role) === "tutor") {
      await TutorProfile.deleteOne({ userId });
    }

    // Finally remove the user
    await User.deleteOne({ _id: userId });

    await logActivity(req, "ADMIN_HARD_DELETE_USER", { targetUserId: userId, role: user.role });

    return res.status(200).json({
      success: true,
      message: "User permanently deleted",
    });
  } catch (error) {
    console.error("Hard Delete User Error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Server error", error: error.message });
  }
};

module.exports = {
  getAllUsers,
  getUserById,
  updateUserStatus,
  deleteUser,
  hardDeleteUser,
  verifyTutor,
  getDashboardStats,
  getDashboardActivity,
  listAdminSessions,
  listAdminClassesMonitor,
  listAdminBookings,
  migrateUploadsToS3,
};
