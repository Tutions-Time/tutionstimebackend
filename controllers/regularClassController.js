// controllers/regularClassController.js

const RegularClass = require("../models/RegularClass");
const StudentProfile = require("../models/StudentProfile");
const TutorProfile = require("../models/TutorProfile");
const Session = require("../models/Session");
const zoomService = require("../services/zoomService");

const REGULAR_SESSION_DURATION_MINUTES = Number(
  process.env.REGULAR_SESSION_DURATION_MINUTES || 60
);


function buildDateTime(dateStr, timeStr) {
  const [year, month, day] = dateStr.split("-").map(Number);
  const [H, M] = timeStr.split(":").map(Number);

  const d = new Date(year, month - 1, day);
  d.setHours(H, M, 0, 0);
  return d;
}

function buildRegularSessionTopic(rc, dateTime) {
  const subject = rc?.subject || "Regular Class";
  const dateLabel = dateTime.toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  const timeLabel = dateTime.toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${subject} - ${timeLabel} on ${dateLabel}`;
}


exports.getTutorRegularStudents = async (req, res) => {
  try {
    const tutorUserId = req.user.id; // this is User._id

    const regularClasses = await RegularClass.find({
      tutorId: tutorUserId, // you store tutorId = User._id in RegularClass
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
      userId: { $in: studentUserIds },
    })
      .select("userId name photoUrl")
      .lean();

    const studentMap = new Map(
      students.map((s) => [String(s.userId), s])
    );

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

    // Load Tutor Availability
    if (
      !tutorProfile ||
      !Array.isArray(tutorProfile.availability) ||
      tutorProfile.availability.length === 0
    ) {
      return res.status(400).json({
        success: false,
        message: "Tutor availability is not set",
      });
    }

    const todayStr = new Date().toISOString().slice(0, 10);
    const futureDates = tutorProfile.availability
      .filter((d) => d >= todayStr)
      .sort();

    if (!futureDates.length) {
      return res.status(400).json({
        success: false,
        message: "Tutor has no upcoming availability",
      });
    }

    let selectedDates = [];

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

      selectedDates = futureDates.slice(0, n);

      if (selectedDates.length < n) {
        return res.status(400).json({
          success: false,
          message: "Tutor does not have enough availability for these classes",
        });
      }
    }

    // ------------------------------
    // 🔥 2️⃣ MONTHLY PLAN (automatic)
    // ------------------------------
    else if (rc.planType === "monthly") {
      const start = new Date(rc.startDate);
      const monthPrefix = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1))
        .toISOString()
        .slice(0, 7);
      selectedDates = futureDates.filter((d) => d.startsWith(monthPrefix));

      if (!selectedDates.length) {
        const nextMonth = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
        const nextMonthPrefix = nextMonth.toISOString().slice(0, 7);
        selectedDates = futureDates.filter((d) => d.startsWith(nextMonthPrefix));
      }

      if (!selectedDates.length) {
        selectedDates = futureDates.slice(0, Math.min(futureDates.length, 8));
      }
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

    // 1) Find all PAID + ACTIVE regular classes for this student
    let regularClasses = await RegularClass.find({
      studentId: studentUserId, // you store studentId = User._id in RegularClass
      paymentStatus: "paid",
      status: "active",
    })
      .sort({ createdAt: -1 })
      .lean();

    if (!regularClasses.length) {
      return res.json({ success: true, data: [] });
    }

    // 2) Remove classes whose tutor is suspended
    const tutorUserIds = regularClasses.map((rc) => rc.tutorId.toString());
    const User = require("../models/User");
    const tutorsUsers = await User.find({ _id: { $in: tutorUserIds } }).select("_id status").lean();
    const suspendedTutorUsers = new Set(
      tutorsUsers.filter(u => String(u.status || "").toLowerCase() === "suspended").map(u => String(u._id))
    );
    regularClasses = regularClasses.filter(rc => !suspendedTutorUsers.has(String(rc.tutorId)));

    const tutors = await TutorProfile.find({
      userId: { $in: tutorUserIds },
    })
      .select("userId name photoUrl")
      .lean();

    const tutorMap = new Map(tutors.map((t) => [String(t.userId), t]));

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
    const JOIN_BEFORE_MIN = 5;     // student can join 5 min before start
    const EXPIRE_AFTER_MIN = 5;    // link valid 5 min after end

    // 4) Build response for frontend
    const enriched = regularClasses.map((rc) => {
      const key = String(rc._id);
      const t = tutorMap.get(String(rc.tutorId)) || {};
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
        scheduledTime = startDate.toISOString().slice(11, 16);
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
          userId: rc.tutorId,
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

    const regularClasses = await RegularClass.find({
      tutorId: tutorUserId,
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
      userId: { $in: studentUserIds },
    })
      .select("userId name photoUrl")
      .lean();
    const studentMap = new Map(students.map((s) => [String(s.userId), s]));

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
    const JOIN_BEFORE_MIN = 5;
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
        scheduledTime = startDate.toISOString().slice(11, 16);
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
        },
        studentName: s.name || "Student",
        photoUrl: s.photoUrl || null,
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

    // Authorize: tutor or student assigned to this class
    const isTutor = role === "tutor" && String(rc.tutorId) === String(userId);
    const isStudent = role === "student" && String(rc.studentId) === String(userId);
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

