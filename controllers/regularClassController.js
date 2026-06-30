// controllers/regularClassController.js

const RegularClass = require("../models/RegularClass");
const StudentProfile = require("../models/StudentProfile");
const TutorProfile = require("../models/TutorProfile");
const Session = require("../models/Session");
const zoomService = require("../services/zoomService");
const {
  recalculateSubscriptionReleaseForClass,
} = require("../services/payments/subscriptionPayoutService");

const REGULAR_SESSION_DURATION_MINUTES = Number(
  process.env.REGULAR_SESSION_DURATION_MINUTES || 60
);

function parseTime24ToMinutes(timeStr) {
  const m = String(timeStr || "").trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min) || h < 0 || h > 23 || min < 0 || min > 59) {
    return null;
  }
  return h * 60 + min;
}

function parseTime12ToMinutes(timeStr) {
  const m = String(timeStr || "")
    .trim()
    .match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  const period = String(m[3]).toUpperCase();
  if (!Number.isFinite(h) || !Number.isFinite(min) || h < 1 || h > 12 || min < 0 || min > 59) {
    return null;
  }
  h = h % 12;
  if (period === "PM") h += 12;
  return h * 60 + min;
}

function isTimeWithinPreferredSlots(time24, preferredTimes) {
  const target = parseTime24ToMinutes(time24);
  if (target === null) return false;
  const slots = Array.isArray(preferredTimes) ? preferredTimes : [];
  if (!slots.length) return true;
  let parsedSlotCount = 0;

  for (const slot of slots) {
    const parts = String(slot || "")
      .split("-")
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length !== 2) continue;

    const startMin = parseTime12ToMinutes(parts[0]);
    const endMin = parseTime12ToMinutes(parts[1]);
    if (startMin === null || endMin === null) continue;
    parsedSlotCount += 1;

    if (endMin >= startMin) {
      if (target >= startMin && target <= endMin) return true;
      continue;
    }
    if (target >= startMin || target <= endMin) return true;
  }

  if (parsedSlotCount === 0) return true;
  return false;
}

function formatDateOnly(date) {
  return new Date(date).toISOString().slice(0, 10);
}

function startOfUtcDay(date) {
  const d = new Date(date);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function addUtcDays(date, days) {
  const base = startOfUtcDay(date);
  base.setUTCDate(base.getUTCDate() + days);
  return base;
}

function buildDailyDateRange(startDate, count) {
  return Array.from({ length: count }, (_, index) =>
    formatDateOnly(addUtcDays(startDate, index))
  );
}

function buildMonthlyDateRange(startDate) {
  const start = startOfUtcDay(startDate);
  const monthStart = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1)
  );
  const nextMonthStart = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1)
  );
  const dates = [];

  for (
    let cursor = new Date(monthStart);
    cursor < nextMonthStart;
    cursor = addUtcDays(cursor, 1)
  ) {
    dates.push(formatDateOnly(cursor));
  }

  return dates;
}


function buildDateTime(dateStr, timeStr) {
  const [year, month, day] = dateStr.split("-").map(Number);
  const [H, M] = timeStr.split(":").map(Number);
  // Preserve raw tutor-entered wall-clock time without timezone math.
  return new Date(Date.UTC(year, month - 1, day, H, M, 0, 0));
}

function buildRegularSessionTopic(rc, dateTime) {
  const subject = rc?.subject || "Regular Class";
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


exports.getTutorRegularStudents = async (req, res) => {
  try {
    const tutorUserId = req.user.id; // this is User._id
    const tutorProfile = await TutorProfile.findOne({ userId: tutorUserId })
      .select("_id")
      .lean();
    const tutorIds = [String(tutorUserId)];
    if (tutorProfile?._id) tutorIds.push(String(tutorProfile._id));

    const regularClasses = await RegularClass.find({
      tutorId: { $in: tutorIds }, // support both User._id and TutorProfile._id
      paymentStatus: "paid",
      status: "active",
    })
      .sort({ createdAt: -1 })
      .lean();

    if (!regularClasses.length) {
      return res.json({ success: true, data: [] });
    }

    const studentUserIds = regularClasses.map((rc) =>
      rc.studentId.toString()
    );

    const students = await StudentProfile.find({
      $or: [{ _id: { $in: studentUserIds } }, { userId: { $in: studentUserIds } }],
    })
      .select("userId name photoUrl")
      .lean();

    const studentMap = new Map();
    for (const s of students) {
      studentMap.set(String(s._id), s);
      if (s.userId) studentMap.set(String(s.userId), s);
    }

    const enriched = regularClasses.map((rc) => {
      const s = studentMap.get(String(rc.studentId)) || {};
      return {
        regularClassId: rc._id,
        studentId: rc.studentId,
        studentName: s.name || "Student",
        photoUrl: s.photoUrl || null,
        subject: rc.subject,
        planType: rc.planType,
        startDate: rc.startDate,
        paymentStatus: rc.paymentStatus,
        tutorPaymentStatus: rc.tutorPaymentStatus || "locked",
        status: rc.status,
        scheduleStatus: rc.scheduleStatus ?? "not-scheduled",
      };
    });

    res.json({ success: true, data: enriched });
  } catch (err) {
    console.error("getTutorRegularStudents error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
};


exports.scheduleRegularClassSessions = async (req, res) => {
  console.log("scheduleRegularClassSessions called");
  try {
    const tutorUserId = req.user.id;
    const rcId = req.params.id;
    const { time } = req.body; // ONLY time is needed now!

    if (!time) {
      return res.status(400).json({
        success: false,
        message: "time (HH:MM) is required",
      });
    }

    // Fetch Regular Class
    const rc = await RegularClass.findById(rcId);
    if (!rc) {
      return res.status(404).json({
        success: false,
        message: "Regular class not found",
      });
    }

    const tutorProfile = await TutorProfile.findOne({ userId: tutorUserId }).lean();

    // Check Tutor Ownership — support both User._id and TutorProfile._id stored in rc.tutorId
    const ownsClass =
      String(rc.tutorId) === String(tutorUserId) ||
      (tutorProfile && String(rc.tutorId) === String(tutorProfile._id));

    if (!ownsClass) {
      return res.status(403).json({
        success: false,
        message: "Not authorized",
      });
    }

    // Ensure payment is completed and class active
    if (rc.paymentStatus !== "paid" || rc.status !== "active") {
      return res.status(400).json({
        success: false,
        message: "Regular class is not active & paid yet",
      });
    }

    const studentProfile =
      (await StudentProfile.findOne({ userId: rc.studentId }).select("preferredTimes").lean()) ||
      (await StudentProfile.findById(rc.studentId).select("preferredTimes").lean());
    const studentPreferredTimes = Array.isArray(studentProfile?.preferredTimes)
      ? studentProfile.preferredTimes
      : [];
    if (
      studentPreferredTimes.length > 0 &&
      !isTimeWithinPreferredSlots(time, studentPreferredTimes)
    ) {
      return res.status(400).json({
        success: false,
        message: "Please select a time within student's preferred time slots",
        preferredTimes: studentPreferredTimes,
      });
    }

    if (!tutorProfile) {
      return res.status(400).json({
        success: false,
        message: "Tutor profile not found",
      });
    }

    let selectedDates = [];
    const scheduleStartDate =
      startOfUtcDay(rc.startDate) > startOfUtcDay(new Date())
        ? startOfUtcDay(rc.startDate)
        : startOfUtcDay(new Date());

    // ------------------------------
    // 🔥 1️⃣ HOURLY PLAN (automatic)
    // ------------------------------
    if (rc.planType === "hourly") {
      const n = rc.classCount; // Use classCount stored earlier

      if (!n || n <= 0) {
        return res.status(400).json({
          success: false,
          message: "Invalid classCount stored in regular class",
        });
      }

      selectedDates = buildDailyDateRange(scheduleStartDate, n);
    }

    // ------------------------------
    // 🔥 2️⃣ MONTHLY PLAN (automatic)
    // ------------------------------
    else if (rc.planType === "monthly") {
      selectedDates = buildMonthlyDateRange(scheduleStartDate);
    } else {
      return res.status(400).json({
        success: false,
        message: "PlanType must be hourly or monthly",
      });
    }

    // ------------------------------
    // 🧹 Clear old sessions (if rescheduling)
    // ------------------------------
    // Resolve StudentProfile._id and TutorProfile._id for sessions
    const resolvedStudentProfile =
      (await StudentProfile.findOne({ userId: rc.studentId }).select("_id")) ||
      (await StudentProfile.findById(rc.studentId).select("_id"));
    const resolvedTutorProfile =
      tutorProfile || (await TutorProfile.findById(rc.tutorId).lean());

    const studentProfileId = resolvedStudentProfile?._id || rc.studentId;
    const tutorProfileId = resolvedTutorProfile?._id || rc.tutorId;

    // ------------------------------
    // 🧪 Create Sessions Automatically
    // ------------------------------

    const sessionsToInsert = [];
    for (const dateStr of selectedDates) {
      const startDateTime = buildDateTime(dateStr, time);
      const topic = buildRegularSessionTopic(rc, startDateTime);
      const meeting = await zoomService.createZoomMeeting({
        topic,
        startTime: startDateTime.toISOString(),
        duration: REGULAR_SESSION_DURATION_MINUTES,
      });

      sessionsToInsert.push({
        regularClassId: rc._id,
        studentId: studentProfileId,
        tutorId: tutorProfileId,
        startDateTime,
        meetingId: meeting.id ? String(meeting.id) : "",
        meetingPassword: meeting.password || meeting.encrypted_password || "",
        startUrl: meeting.start_url || "",
        joinUrl: meeting.join_url || "",
        meetingLink: meeting.join_url || "",
        status: "scheduled",
      });
    }

    await Session.deleteMany({ regularClassId: rcId });

    const created = await Session.insertMany(sessionsToInsert);


    rc.scheduleStatus = "scheduled";
    await rc.save();
    await recalculateSubscriptionReleaseForClass(rc._id);

    try {
      const { createAdminNotification } = require("../services/adminNotification");
      void createAdminNotification(
        "Regular Class Sessions Scheduled",
        `Tutor ${tutorProfile?.name || tutorUserId} scheduled ${created.length} sessions for class ${rc.subject} with student ${rc.studentId}`,
        {
          regularClassId: rc._id,
          tutorId: tutorUserId,
          studentId: rc.studentId,
          sessionCount: created.length,
          subject: rc.subject
        }
      );
    } catch (_) {}

    return res.json({
      success: true,
      message: "Sessions auto-scheduled successfully",
      data: created,
    });
  } catch (err) {
    console.error("scheduleRegularClassSessions error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
};


exports.getStudentRegularClasses = async (req, res) => {
  try {
    const studentUserId = req.user.id; // this is User._id
    const studentProfile = await StudentProfile.findOne({ userId: studentUserId })
      .select("_id")
      .lean();
    const studentIds = [String(studentUserId)];
    if (studentProfile?._id) studentIds.push(String(studentProfile._id));

    // 1) Find all PAID + ACTIVE regular classes for this student
    let regularClasses = await RegularClass.find({
      studentId: { $in: studentIds }, // support both User._id and StudentProfile._id
      paymentStatus: "paid",
      status: "active",
    })
      .sort({ createdAt: -1 })
      .lean();

    if (!regularClasses.length) {
      return res.json({ success: true, data: [] });
    }

    // 2) Remove classes whose tutor is suspended
    const tutorRefIds = regularClasses.map((rc) => rc.tutorId.toString());
    const tutorProfiles = await TutorProfile.find({
      $or: [{ _id: { $in: tutorRefIds } }, { userId: { $in: tutorRefIds } }],
    })
      .select("_id userId name photoUrl")
      .lean();
    const tutorByRefId = new Map();
    for (const t of tutorProfiles) {
      tutorByRefId.set(String(t._id), t);
      if (t.userId) tutorByRefId.set(String(t.userId), t);
    }
    const tutorUserIds = tutorProfiles
      .map((t) => (t.userId ? String(t.userId) : null))
      .filter(Boolean);
    const User = require("../models/User");
    const tutorsUsers = await User.find({ _id: { $in: tutorUserIds } }).select("_id status").lean();
    const suspendedTutorUsers = new Set(
      tutorsUsers.filter(u => String(u.status || "").toLowerCase() === "suspended").map(u => String(u._id))
    );
    regularClasses = regularClasses.filter((rc) => {
      const tp = tutorByRefId.get(String(rc.tutorId));
      const tutorUserId = tp?.userId ? String(tp.userId) : String(rc.tutorId);
      return !suspendedTutorUsers.has(tutorUserId);
    });

    // 3) Load sessions for each regular class
    const rcIds = regularClasses.map((rc) => rc._id);
    const now = new Date();

    const sessions = await Session.find({
      regularClassId: { $in: rcIds },
      status: "scheduled",
    })
      .sort({ startDateTime: 1 })
      .lean();

    const nextSessionMap = new Map();  // regularClassId -> next upcoming session
    const sessionsCountMap = new Map(); // regularClassId -> total upcoming sessions

    for (const s of sessions) {
      const key = String(s.regularClassId);
      const sStart = new Date(s.startDateTime);

      // Count only future sessions for upcomingSessionsCount
      if (sStart >= now) {
        sessionsCountMap.set(
          key,
          (sessionsCountMap.get(key) || 0) + 1
        );

        // first future session in sorted list is the "next" session
        if (!nextSessionMap.has(key)) {
          nextSessionMap.set(key, s);
        }
      }
    }

    // Join window config
    const CLASS_DURATION_MIN = 60; // assume 1-hour class
    const JOIN_BEFORE_MIN = 10;     // student can join 10 min before start
    const EXPIRE_AFTER_MIN = 5;    // link valid 5 min after end

    // 4) Build response for frontend
    const enriched = regularClasses.map((rc) => {
      const key = String(rc._id);
      const t = tutorByRefId.get(String(rc.tutorId)) || {};
      const nextSession = nextSessionMap.get(key) || null;

      let canJoin = false;
      let scheduledTime = null; // simple "HH:MM"

      if (nextSession) {
        const startDate = new Date(nextSession.startDateTime);
        const startMs = startDate.getTime();
        const endMs = startMs + CLASS_DURATION_MIN * 60 * 1000;
        const nowMs = now.getTime();

        const joinOpenAt = startMs - JOIN_BEFORE_MIN * 60 * 1000;
        const joinCloseAt = endMs + EXPIRE_AFTER_MIN * 60 * 1000;

        if (nowMs >= joinOpenAt && nowMs <= joinCloseAt) {
          canJoin = true; // link is "live" for present class
        }

        // schedule time as "HH:MM"
        scheduledTime = startDate.toLocaleTimeString("en-IN", {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
          timeZone: "UTC",
        });
      }

      return {
        regularClassId: rc._id,
        subject: rc.subject,
        planType: rc.planType,                 // hourly / monthly
        classCount: rc.classCount,             // for hourly plans
        startDate: rc.startDate,
        paymentStatus: rc.paymentStatus,
        tutorPaymentStatus: rc.tutorPaymentStatus || "locked",
        status: rc.status,                     // active / paused / ended
        scheduleStatus: rc.scheduleStatus ?? "not-scheduled",

        tutor: {
          userId: t.userId || rc.tutorId,
          name: t.name || "Tutor",
          photoUrl: t.photoUrl || null,
        },

        nextSession: nextSession
          ? {
              sessionId: nextSession._id,
              startDateTime: nextSession.startDateTime, // full datetime
              scheduledTime,                            
              meetingLink: nextSession.joinUrl || nextSession.meetingLink || null,
              joinUrl: nextSession.joinUrl || null,
              startUrl: nextSession.startUrl || null,
              meetingId: nextSession.meetingId || null,
              meetingPassword: nextSession.meetingPassword || null,
              status: nextSession.status,
              canJoin,                                  
            }
          : null,

        upcomingSessionsCount: sessionsCountMap.get(key) || 0,
      };
    });

    return res.json({
      success: true,
      data: enriched,
    });
  } catch (err) {
    console.error("getStudentRegularClasses error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Server error" });
  }
};

exports.getTutorRegularClasses = async (req, res) => {
  try {
    const tutorUserId = req.user.id;
    const tutorProfile = await TutorProfile.findOne({ userId: tutorUserId })
      .select("_id")
      .lean();
    const tutorIds = [String(tutorUserId)];
    if (tutorProfile?._id) tutorIds.push(String(tutorProfile._id));

    const regularClasses = await RegularClass.find({
      tutorId: { $in: tutorIds },
      paymentStatus: "paid",
      status: "active",
    })
      .sort({ createdAt: -1 })
      .lean();

    if (!regularClasses.length) {
      return res.json({ success: true, data: [] });
    }

    const studentUserIds = regularClasses.map((rc) => rc.studentId.toString());
    const students = await StudentProfile.find({
      $or: [{ _id: { $in: studentUserIds } }, { userId: { $in: studentUserIds } }],
    })
      .select("userId name photoUrl preferredTimes")
      .lean();
    const studentMap = new Map();
    for (const s of students) {
      studentMap.set(String(s._id), s);
      if (s.userId) studentMap.set(String(s.userId), s);
    }

    const rcIds = regularClasses.map((rc) => rc._id);
    const now = new Date();
    const sessions = await Session.find({
      regularClassId: { $in: rcIds },
    })
      .sort({ startDateTime: 1 })
      .lean();

    const nextSessionMap = new Map();
    const sessionsCountMap = new Map();
    for (const s of sessions) {
      const key = String(s.regularClassId);
      const sStart = new Date(s.startDateTime);
      if (sStart >= now) {
        sessionsCountMap.set(key, (sessionsCountMap.get(key) || 0) + 1);
        if (!nextSessionMap.has(key)) {
          nextSessionMap.set(key, s);
        }
      }
    }

    const CLASS_DURATION_MIN = 60;
    const JOIN_BEFORE_MIN = 10;
    const EXPIRE_AFTER_MIN = 5;

    const enriched = regularClasses.map((rc) => {
      const key = String(rc._id);
      const s = studentMap.get(String(rc.studentId)) || {};
      const nextSession = nextSessionMap.get(key) || null;

      // feedback summary per class (from completed sessions)
      const completedForClass = sessions.filter((x) => String(x.regularClassId) === key && x.status === "completed");
      const withFeedback = completedForClass.filter((x) => x.sessionFeedback && typeof x.sessionFeedback.overall === "number");
      const avgOverall = withFeedback.length
        ? withFeedback.reduce((sum, x) => sum + (x.sessionFeedback.overall || 0), 0) / withFeedback.length
        : 0;
      const recentComments = withFeedback
        .map((x) => ({ c: (x.sessionFeedback.comment || "").trim(), t: x.sessionFeedback.createdAt || x.startDateTime }))
        .filter((z) => !!z.c)
        .sort((a, b) => new Date(b.t).getTime() - new Date(a.t).getTime())
        .slice(0, 5)
        .map((z) => z.c);

      let canJoin = false;
      let scheduledTime = null;

      if (nextSession) {
        const startDate = new Date(nextSession.startDateTime);
        const startMs = startDate.getTime();
        const endMs = startMs + CLASS_DURATION_MIN * 60 * 1000;
        const nowMs = now.getTime();
        const joinOpenAt = startMs - JOIN_BEFORE_MIN * 60 * 1000;
        const joinCloseAt = endMs + EXPIRE_AFTER_MIN * 60 * 1000;
        if (nowMs >= joinOpenAt && nowMs <= joinCloseAt) {
          canJoin = true;
        }
        scheduledTime = startDate.toLocaleTimeString("en-IN", {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
          timeZone: "UTC",
        });
      }

      return {
        regularClassId: rc._id,
        subject: rc.subject,
        planType: rc.planType,
        classCount: rc.classCount,
        startDate: rc.startDate,
        paymentStatus: rc.paymentStatus,
        tutorPaymentStatus: rc.tutorPaymentStatus || "locked",
        status: rc.status,
        scheduleStatus: rc.scheduleStatus ?? "not-scheduled",
        student: {
          userId: rc.studentId,
          name: s.name || "Student",
          photoUrl: s.photoUrl || null,
          preferredTimes: Array.isArray(s.preferredTimes) ? s.preferredTimes : [],
        },
        studentName: s.name || "Student",
        photoUrl: s.photoUrl || null,
        preferredTimes: Array.isArray(s.preferredTimes) ? s.preferredTimes : [],
        feedbackSummary: {
          averageOverall: avgOverall,
          commentCount: recentComments.length,
          recentComments,
        },
        nextSession: nextSession
          ? {
              sessionId: nextSession._id,
              startDateTime: nextSession.startDateTime,
              scheduledTime,
              meetingLink: nextSession.startUrl || nextSession.meetingLink || null,
              joinUrl: nextSession.joinUrl || null,
              startUrl: nextSession.startUrl || null,
              meetingId: nextSession.meetingId || null,
              meetingPassword: nextSession.meetingPassword || null,
              status: nextSession.status,
              canJoin,
            }
          : null,
        upcomingSessionsCount: sessionsCountMap.get(key) || 0,
      };
    });

    return res.json({ success: true, data: enriched });
  } catch (err) {
    console.error("getTutorRegularClasses error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

// List all sessions for a given regular class
exports.getRegularClassSessions = async (req, res) => {
  try {
    const userId = req.user.id;
    const role = req.user.role;
    const rcId = req.params.id;

    const rc = await RegularClass.findById(rcId).lean();
    if (!rc) {
      return res.status(404).json({ success: false, message: "Regular class not found" });
    }

    // Authorize: tutor or student assigned to this class (support both User and Profile ids)
    const tutorProfile =
      role === "tutor"
        ? await TutorProfile.findOne({ userId }).select("_id").lean()
        : null;
    const studentProfile =
      role === "student"
        ? await StudentProfile.findOne({ userId }).select("_id").lean()
        : null;
    const isTutor =
      role === "tutor" &&
      (String(rc.tutorId) === String(userId) ||
        (tutorProfile && String(rc.tutorId) === String(tutorProfile._id)));
    const isStudent =
      role === "student" &&
      (String(rc.studentId) === String(userId) ||
        (studentProfile && String(rc.studentId) === String(studentProfile._id)));
    if (!isTutor && !isStudent) {
      return res.status(403).json({ success: false, message: "Not authorized" });
    }

    const sessions = await Session.find({ regularClassId: rcId })
      .sort({ startDateTime: 1 })
      .lean();

    return res.json({ success: true, data: sessions });
  } catch (err) {
    console.error("getRegularClassSessions error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

