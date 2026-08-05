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
const { logActivity } = require("../services/loggerService");
const { createAdminNotification } = require("../services/adminNotification");
const notificationService = require("../services/notificationService");
const suspensionController = require("./suspensionController");
const {
  DEFAULT_SESSION_DURATION_MINUTES,
  computeDurationMinutes,
  buildGroupSessionTopic,
} = require("../utils/sessionZoomUtils");
const zoomService = require("../services/zoomService");

const DEMO_DURATION_MINUTES = 15;
const BOOKING_TZ_OFFSET_MIN = Number(process.env.BOOKING_TZ_OFFSET_MIN || 330);

function getDemoStartDateTime(booking) {
  if (!booking?.preferredDate || !booking?.preferredTime) return null;
  const baseUtc = new Date(booking.preferredDate);
  const [hourStr, minuteStr] = String(booking.preferredTime).split(":");
  const hour = Number(hourStr);
  const minute = Number(minuteStr);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;

  const shifted = new Date(baseUtc.getTime() + BOOKING_TZ_OFFSET_MIN * 60000);
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth();
  const day = shifted.getUTCDate();
  const utcMs =
    Date.UTC(year, month, day, hour, minute, 0, 0) -
    BOOKING_TZ_OFFSET_MIN * 60000;

  return new Date(utcMs);
}

function buildDemoTopicForAdmin(booking) {
  const subject = booking?.subject || "tuitionstime Demo";
  if (!booking?.preferredDate) return subject;
  const dateLabel = new Date(booking.preferredDate).toLocaleDateString("en-IN");
  return `${subject} (${dateLabel})`;
}

function formatTime12(timeStr) {
  const match = String(timeStr || "").trim().match(/^(\d{1,2}):(\d{2})/);
  if (!match) return String(timeStr || "");
  let hour = Number(match[1]);
  const minute = match[2];
  if (!Number.isFinite(hour)) return String(timeStr || "");
  const period = hour >= 12 ? "PM" : "AM";
  hour = hour % 12 || 12;
  return `${hour}:${minute} ${period}`;
}

async function ensureAdminDemoZoomMeeting(booking) {
  const startDateTime = getDemoStartDateTime(booking);
  if (!startDateTime) {
    throw new Error("Unable to calculate demo start time for Zoom meeting.");
  }

  const meeting = await zoomService.createZoomMeeting({
    topic: buildDemoTopicForAdmin(booking),
    startTime: startDateTime.toISOString(),
    duration: DEMO_DURATION_MINUTES,
  });

  booking.meetingId = meeting.id ? String(meeting.id) : booking.meetingId || "";
  booking.meetingPassword =
    meeting.password || meeting.encrypted_password || booking.meetingPassword || "";
  booking.startUrl = meeting.start_url || booking.startUrl || "";
  booking.joinUrl = meeting.join_url || booking.joinUrl || "";
  booking.meetingLink = booking.joinUrl || booking.meetingLink || "";
}

function parseAdminSessionDateTime(date, time, mode = "regular") {
  const [year, month, day] = String(date || "").split("-").map(Number);
  const [hour, minute] = String(time || "").split(":").map(Number);
  if (
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day) ||
    !Number.isFinite(hour) ||
    !Number.isFinite(minute)
  ) {
    return null;
  }

  if (mode === "group") {
    const yyyy = String(year).padStart(4, "0");
    const mm = String(month).padStart(2, "0");
    const dd = String(day).padStart(2, "0");
    const hh = String(Math.max(0, Math.min(23, hour))).padStart(2, "0");
    const min = String(Math.max(0, Math.min(59, minute))).padStart(2, "0");
    const parsed = new Date(`${yyyy}-${mm}-${dd}T${hh}:${min}:00+05:30`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const parsed = new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function buildRegularSessionTopicForAdmin(regularClass, dateTime) {
  const subject = regularClass?.subject || "Regular Class";
  const dateLabel = dateTime.toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
  const timeLabel = dateTime.toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });
  return `${subject} - ${timeLabel} on ${dateLabel}`;
}

const migrateUploadsToS3 = async (req, res) => {
  try {
    return res.status(410).json({
      success: false,
      message:
        "S3 upload migration is disabled. New uploads are stored on this server.",
    });
  } catch (err) {
    console.error("migrateUploadsToS3 error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Server error", error: err.message });
  }
};

// Get all users with pagination + filters + search
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

    const requestedRole = role && ["student", "tutor", "admin"].includes(String(role)) ? String(role) : null;
    const requestedStatus = status && ["active", "inactive", "suspended"].includes(String(status)) ? String(status) : null;
    const andClauses = [];
    andClauses.push({ isDeleted: { $ne: true } });
    if (requestedRole) andClauses.push({ role: requestedRole });
    if (requestedStatus) {
      if (requestedRole === "student") {
        if (requestedStatus === "suspended") {
          andClauses.push({ status: "suspended" });
        } else {
          andClauses.push({
            status: { $ne: "suspended" },
            isProfileComplete: requestedStatus === "active",
          });
        }
      } else {
        andClauses.push({ status: requestedStatus });
      }
    }

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
      const adminStatus =
        u.role === "student" && u.status !== "suspended"
          ? u.isProfileComplete
            ? "active"
            : "inactive"
          : u.status;
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
        status: adminStatus,
        isProfileComplete: u.isProfileComplete,
        lastLogin: u.lastLogin,
        createdAt: u.createdAt,
        profilePhoto: photoUrl,
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

    res.status(200).json({
      success: true,
      data: {
        user: { ...userObj, id: user._id },
        profile: profile || null,
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
    const { status, reason, explanation } = req.body;

    if (!["active", "inactive", "suspended"].includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Invalid status value. Use active, inactive or suspended.",
      });
    }

    
    if (status === "suspended" && !String(reason || "").trim()) {
      return res.status(400).json({
        success: false,
        message: "Suspension reason is required.",
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

    if (status === "suspended" && ["student", "tutor"].includes(user.role)) {
      try {
        await suspensionController.createSuspensionCaseAndNotify({ req, user, reason, explanation });
      } catch (err) {
        if (err.statusCode === 400) {
          return res.status(400).json({ success: false, message: err.message });
        }
        console.warn("Suspension notification failed:", err.message);
      }
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
      .populate({ path: "studentId", select: "name photoUrl learningMode" })
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
      regularMode,
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

    const [studentIds, tutorIds, enrolledGroupBatches] = await Promise.all([
      resolveStudentIds(student),
      resolveTutorIds(tutor),
      GroupBatch.find({ "enrolled.0": { $exists: true } })
        .select("_id")
        .lean(),
    ]);
    const enrolledGroupBatchIds = enrolledGroupBatches.map((b) => b._id);

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
      andClauses.push({ groupBatchId: { $in: enrolledGroupBatchIds } });
    } else if (kind === "regular") {
      andClauses.push({
        $and: [
          { regularClassId: { $exists: true, $ne: null } },
          {
            $or: [
              { groupBatchId: { $exists: false } },
              { groupBatchId: { $in: [null, undefined] } },
            ],
          },
        ],
      });
    } else {
      andClauses.push({
        $or: [
          { groupBatchId: { $exists: false } },
          { groupBatchId: { $in: [null, undefined] } },
          { groupBatchId: { $in: enrolledGroupBatchIds } },
        ],
      });
    }

    if (status) {
      andClauses.push({ status: String(status) });
    }

    const filter = andClauses.length ? { $and: andClauses } : {};
    const sessions = await Session.find(filter)
      .sort({ startDateTime: -1, _id: -1 })
      .populate({ path: "studentId", select: "name photoUrl learningMode" })
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
        const classMode = kindValue === "regular" ? String(s.studentId?.learningMode || "").trim() : "";
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
          classMode: classMode || null,
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

        const requestedRegularMode = String(regularMode || "").trim().toLowerCase();
        if (
          kindValue === "regular" &&
          ["online", "offline"].includes(requestedRegularMode) &&
          classMode.toLowerCase() !== requestedRegularMode
        ) {
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
    const {
      status,
      startDate,
      endDate,
      requestedBy,
      q,
      page = 1,
      limit = 50,
    } = req.query;
    const pageNum = Math.max(1, Number(page));
    const limitNum = Math.max(1, Number(limit));
    const skip = Math.max(0, (pageNum - 1) * limitNum);

    const andClauses = [{ type: "demo" }];
    if (status) andClauses.push({ status });
    if (requestedBy) andClauses.push({ requestedBy });
    if (startDate || endDate) {
      const range = {};
      if (startDate) range.$gte = new Date(startDate);
      if (endDate) range.$lte = new Date(endDate);
      andClauses.push({ preferredDate: range });
    }
    const filter = andClauses.length ? { $and: andClauses } : {};

    let bookings = await Booking.find(filter)
      .sort({ preferredDate: -1, createdAt: -1 })
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
    const allUserIds = [...studentUserIds, ...tutorUserIds];

    const [studentProfiles, tutorProfiles, users] = await Promise.all([
      StudentProfile.find({ userId: { $in: studentUserIds } })
        .select("userId name email altPhone photoUrl classLevel board track subjects goals learningMode city state pincode")
        .lean(),
      TutorProfile.find({ userId: { $in: tutorUserIds } })
        .select("userId name email altPhone photoUrl qualification experience subjects classLevels teachingMode hourlyRate monthlyRate city state pincode isVerified status")
        .lean(),
      User.find({ _id: { $in: allUserIds } })
        .select("_id email phone role status isProfileComplete")
        .lean(),
    ]);

    const studentMap = new Map(
      studentProfiles.map((p) => [String(p.userId), p]),
    );
    const tutorMap = new Map(tutorProfiles.map((p) => [String(p.userId), p]));
    const userMap = new Map(users.map((u) => [String(u._id), u]));

    const makePerson = (userId, profile, fallbackRole) => {
      const user = userMap.get(String(userId)) || {};
      return {
        userId,
        _id: userId,
        name: profile?.name || "Unknown",
        email: profile?.email || user.email || "",
        phone: profile?.altPhone || user.phone || "",
        photoUrl: profile?.photoUrl || "",
        role: user.role || fallbackRole,
        status: user.status || "",
        isProfileComplete: Boolean(user.isProfileComplete),
        profile: profile || null,
      };
    };

    let data = bookings.map((b) => ({
      _id: b._id,
      status: b.status,
      subject: b.subject,
      subjects: b.subjects || [],
      studentBoard: b.studentBoard || "",
      studentLearningMode: b.studentLearningMode || "",
      preferredDate: b.preferredDate,
      preferredTime: b.preferredTime,
      preferredEndTime: b.preferredEndTime || "",
      note: b.note || "",
      requestedBy: b.requestedBy || "student",
      expiryReason: b.expiryReason || null,
      expiredAt: b.expiredAt || null,
      createdAt: b.createdAt,
      updatedAt: b.updatedAt,
      attendance: b.attendance || "not-marked",
      studentJoinedAt: b.studentJoinedAt || null,
      tutorJoinedAt: b.tutorJoinedAt || null,
      demoFeedback: b.demoFeedback || null,
      meetingLink: b.joinUrl || b.meetingLink || "",
      joinUrl: b.joinUrl || "",
      startUrl: b.startUrl || "",
      meetingId: b.meetingId || "",
      meetingPassword: b.meetingPassword || "",
      student: makePerson(
        b.studentId,
        studentMap.get(String(b.studentId)),
        "student",
      ),
      tutor: makePerson(b.tutorId, tutorMap.get(String(b.tutorId)), "tutor"),
    }));

    const query = String(q || "").trim().toLowerCase();
    if (query) {
      data = data.filter((b) => {
        const haystack = [
          b.subject,
          b.status,
          b.requestedBy,
          b.student?.name,
          b.student?.email,
          b.student?.phone,
          b.tutor?.name,
          b.tutor?.email,
          b.tutor?.phone,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return haystack.includes(query);
      });
    }

    const total = data.length;
    data = data.slice(skip, skip + limitNum);

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

const cancelAdminDemoBooking = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body || {};

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid booking id" });
    }

    const booking = await Booking.findById(id);
    if (!booking || booking.type !== "demo") {
      return res.status(404).json({ success: false, message: "Demo booking not found" });
    }

    if (["cancelled", "rejected", "completed", "expired"].includes(booking.status)) {
      return res.status(400).json({
        success: false,
        message: `Cannot cancel a ${booking.status} demo booking`,
      });
    }

    booking.status = "cancelled";
    booking.expiryReason = null;
    booking.note = [booking.note, reason ? `Admin cancelled: ${reason}` : "Admin cancelled"]
      .filter(Boolean)
      .join("\n");
    await booking.save();

    const [studentProfile, tutorProfile] = await Promise.all([
      StudentProfile.findOne({ userId: booking.studentId }).select("name").lean(),
      TutorProfile.findOne({ userId: booking.tutorId }).select("name").lean(),
    ]);

    await Promise.allSettled([
      Notification.create({
        userId: booking.studentId,
        title: "Demo Cancelled",
        body:
          reason ||
          `Your demo for ${booking.subject} was cancelled by admin.`,
        meta: { type: "demo_cancelled", bookingId: booking._id },
      }),
      Notification.create({
        userId: booking.tutorId,
        title: "Demo Cancelled",
        body:
          reason ||
          `Your demo for ${booking.subject} was cancelled by admin.`,
        meta: { type: "demo_cancelled", bookingId: booking._id },
      }),
      createAdminNotification(
        "Demo Cancelled by Admin",
        `Admin cancelled ${booking.subject} demo between ${studentProfile?.name || "student"} and ${tutorProfile?.name || "tutor"}.`,
        { type: "demo_cancelled", bookingId: booking._id },
      ),
    ]);

    return res.status(200).json({
      success: true,
      message: "Demo booking cancelled successfully",
      data: booking,
    });
  } catch (error) {
    return res
      .status(500)
      .json({ success: false, message: "Server error", error: error.message });
  }
};

const deleteAdminDemoBooking = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid booking id" });
    }

    const booking = await Booking.findById(id);
    if (!booking || booking.type !== "demo") {
      return res.status(404).json({ success: false, message: "Demo booking not found" });
    }

    await Booking.deleteOne({ _id: id });

    await createAdminNotification(
      "Demo Deleted by Admin",
      `Admin deleted ${booking.subject || "demo"} booking ${booking._id}.`,
      {
        type: "demo_deleted",
        bookingId: booking._id,
        studentId: booking.studentId,
        tutorId: booking.tutorId,
        status: booking.status,
      },
    );

    return res.status(200).json({
      success: true,
      message: "Demo booking deleted successfully",
    });
  } catch (error) {
    return res
      .status(500)
      .json({ success: false, message: "Server error", error: error.message });
  }
};

const acceptAdminDemoBooking = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid booking id" });
    }

    const booking = await Booking.findById(id);
    if (!booking || booking.type !== "demo") {
      return res.status(404).json({ success: false, message: "Demo booking not found" });
    }

    if (booking.status !== "pending") {
      return res.status(400).json({
        success: false,
        message: `Cannot accept a ${booking.status} demo booking`,
      });
    }

    booking.status = "confirmed";
    booking.expiryReason = null;
    booking.expiredAt = null;
    if (!booking.joinUrl || !booking.startUrl) {
      await ensureAdminDemoZoomMeeting(booking);
    }
    booking.meetingLink = booking.joinUrl || booking.meetingLink || "";
    await booking.save();

    const [studentProfile, tutorProfile] = await Promise.all([
      StudentProfile.findOne({ userId: booking.studentId }).select("name email").lean(),
      TutorProfile.findOne({ userId: booking.tutorId }).select("name email").lean(),
    ]);

    const studentName = studentProfile?.name || "student";
    const tutorName = tutorProfile?.name || "tutor";
    const displayDate = new Date(booking.preferredDate).toLocaleDateString("en-IN");
    const displayTime = formatTime12(booking.preferredTime);
    const studentLink = booking.joinUrl || booking.meetingLink || "";
    const tutorLink = booking.joinUrl || booking.meetingLink || "";
    const body = `Your demo for ${booking.subject} is booked for ${displayDate}${
      displayTime ? ` at ${displayTime}` : ""
    }.`;

    await Promise.allSettled([
      notificationService.notifyUser(booking.studentId, "Demo Booked", body, {
        type: "demo_confirmed",
        bookingId: booking._id,
        meetingLink: studentLink,
        joinUrl: booking.joinUrl,
        startUrl: booking.startUrl,
        meetingId: booking.meetingId,
      }),
      notificationService.notifyUser(
        booking.tutorId,
        "Demo Booked",
        `Your demo with ${studentName} is booked for ${displayDate}${
          displayTime ? ` at ${displayTime}` : ""
        }.`,
        {
          type: "demo_confirmed",
          bookingId: booking._id,
          meetingLink: tutorLink,
          joinUrl: booking.joinUrl,
          startUrl: booking.startUrl,
          meetingId: booking.meetingId,
        },
      ),
      createAdminNotification(
        "Demo Booked by Admin",
        `Admin booked ${booking.subject} demo between ${studentName} and ${tutorName}.`,
        {
          type: "demo_confirmed",
          bookingId: booking._id,
          studentId: booking.studentId,
          tutorId: booking.tutorId,
          meetingLink: booking.meetingLink,
          joinUrl: booking.joinUrl,
          startUrl: booking.startUrl,
          meetingId: booking.meetingId,
        },
      ),
    ]);

    return res.status(200).json({
      success: true,
      message: "Demo booking booked successfully",
      data: booking,
    });
  } catch (error) {
    return res
      .status(500)
      .json({ success: false, message: "Server error", error: error.message });
  }
};

const updateAdminSessionSchedule = async (req, res) => {
  try {
    const { id } = req.params;
    const { date, time } = req.body || {};

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid session id" });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ""))) {
      return res.status(400).json({ success: false, message: "Valid date is required" });
    }
    if (!/^\d{2}:\d{2}$/.test(String(time || ""))) {
      return res.status(400).json({ success: false, message: "Valid time is required" });
    }

    const session = await Session.findById(id);
    if (!session) {
      return res.status(404).json({ success: false, message: "Session not found" });
    }
    if (session.status !== "scheduled") {
      return res.status(400).json({
        success: false,
        message: "Only scheduled classes can be edited",
      });
    }

    const isGroup = Boolean(session.groupBatchId);
    const nextStart = parseAdminSessionDateTime(date, time, isGroup ? "group" : "regular");
    if (!nextStart) {
      return res.status(400).json({ success: false, message: "Invalid date or time" });
    }

    const previousStart = session.startDateTime;
    let duration = DEFAULT_SESSION_DURATION_MINUTES;
    let topic = "Class";
    if (isGroup) {
      const batch = await GroupBatch.findById(session.groupBatchId).lean();
      duration = computeDurationMinutes(batch?.recurring?.time, batch?.recurring?.endTime);
      topic = buildGroupSessionTopic(batch || {}, nextStart);
    } else {
      const regularClass = session.regularClassId
        ? await RegularClass.findById(session.regularClassId).lean()
        : null;
      topic = buildRegularSessionTopicForAdmin(regularClass || {}, nextStart);
    }

    try {
      const meeting = await zoomService.createZoomMeeting({
        topic,
        startTime: nextStart.toISOString(),
        duration,
      });
      session.meetingId = meeting.id ? String(meeting.id) : session.meetingId || "";
      session.meetingPassword =
        meeting.password || meeting.encrypted_password || session.meetingPassword || "";
      session.startUrl = meeting.start_url || session.startUrl || "";
      session.joinUrl = meeting.join_url || session.joinUrl || "";
      session.meetingLink = meeting.join_url || session.meetingLink || "";
    } catch (err) {
      console.warn("Admin session Zoom refresh failed:", err.message);
    }

    session.startDateTime = nextStart;
    session.actualEndTime = undefined;
    await session.save();

    await logActivity(req, "ADMIN_UPDATE_SESSION_SCHEDULE", {
      sessionId: id,
      previousStart,
      nextStart,
      kind: isGroup ? "group" : "regular",
    });

    return res.json({
      success: true,
      message: "Class schedule updated",
      data: {
        _id: session._id,
        startDateTime: session.startDateTime,
        meetingLink: session.meetingLink || session.joinUrl || "",
      },
    });
  } catch (error) {
    console.error("updateAdminSessionSchedule error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
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
  acceptAdminDemoBooking,
  cancelAdminDemoBooking,
  deleteAdminDemoBooking,
  updateAdminSessionSchedule,
  migrateUploadsToS3,
};















