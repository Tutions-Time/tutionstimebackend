const RegularClass = require("../models/RegularClass");
const StudentProfile = require("../models/StudentProfile");
const TutorProfile = require("../models/TutorProfile");
const Session = require("../models/Session");

/**
 * Helper: build Date from "YYYY-MM-DD" + "HH:MM"
 */
function buildDateTime(dateStr, timeStr) {
  const [year, month, day] = dateStr.split("-").map(Number);
  const [H, M] = timeStr.split(":").map(Number);

  const d = new Date(year, month - 1, day);
  d.setHours(H, M, 0, 0);
  return d;
}

/**
 * 1️⃣ Tutor: Get all students with PAID + ACTIVE regular classes
 * GET /api/regular/tutor/students
 */
exports.getTutorRegularStudents = async (req, res) => {
  try {
    const tutorUserId = req.user.id; // this is User._id

    const regularClasses = await RegularClass.find({
      tutorId: tutorUserId,       // you store tutorId = User._id in RegularClass
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
        planType: rc.planType,     // "hourly" | "monthly" | ...
        startDate: rc.startDate,
        paymentStatus: rc.paymentStatus,
        status: rc.status,
      };
    });

    res.json({ success: true, data: enriched });
  } catch (err) {
    console.error("getTutorRegularStudents error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

/**
 * 2️⃣ Tutor: Schedule sessions based on:
 *    - tutor availability dates
 *    - regularClass.planType ("hourly" or "monthly")
 *    - hourly: numberOfClasses from body
 *    - monthly: all available dates of that month
 *
 * POST /api/regular/tutor/regular-class/:id/schedule
 * Body:
 *    { time: "18:00", numberOfClasses?: 4 }
 */
exports.scheduleRegularClassSessions = async (req, res) => {
  try {
    const tutorUserId = req.user.id; // logged in tutor (User._id)
    const rcId = req.params.id;
    const { time, numberOfClasses } = req.body;

    if (!time) {
      return res.status(400).json({
        success: false,
        message: "time (HH:MM) is required",
      });
    }

    const rc = await RegularClass.findById(rcId);
    if (!rc) {
      return res
        .status(404)
        .json({ success: false, message: "Regular class not found" });
    }

    // 🔐 Tutor owns this class?
    if (rc.tutorId.toString() !== tutorUserId) {
      return res
        .status(403)
        .json({ success: false, message: "Not authorized" });
    }

    // 💰 Ensure payment completed
    if (rc.paymentStatus !== "paid" || rc.status !== "active") {
      return res.status(400).json({
        success: false,
        message: "Regular class is not active & paid yet",
      });
    }

    // Tutor availability comes from TutorProfile.availability (array of YYYY-MM-DD)
    const tutorProfile = await TutorProfile.findOne({ userId: tutorUserId }).lean();
    if (!tutorProfile || !Array.isArray(tutorProfile.availability) || !tutorProfile.availability.length) {
      return res.status(400).json({
        success: false,
        message: "Tutor availability is not set",
      });
    }

    const todayStr = new Date().toISOString().slice(0, 10);

    // Filter only future (or today) availability dates
    const allFutureDates = tutorProfile.availability
      .filter((d) => d >= todayStr)
      .sort();

    if (!allFutureDates.length) {
      return res.status(400).json({
        success: false,
        message: "No upcoming availability dates for tutor",
      });
    }

    let selectedDates = [];

    // ⚙ Logic based on planType
    if (rc.planType === "hourly") {
      // Q1: yes → hourly = number of classes
      if (!numberOfClasses || Number(numberOfClasses) <= 0) {
        return res.status(400).json({
          success: false,
          message: "numberOfClasses is required for hourly plan",
        });
      }

      const n = Number(numberOfClasses);
      selectedDates = allFutureDates.slice(0, n);

      if (selectedDates.length < n) {
        return res.status(400).json({
          success: false,
          message:
            "Tutor does not have enough availability dates for requested classes",
        });
      }
    } else if (rc.planType === "monthly") {
      // Q2: monthly = based on tutor availability for that month
      const baseDate = rc.startDate || new Date();
      const monthPrefix = baseDate.toISOString().slice(0, 7); // "YYYY-MM"

      selectedDates = allFutureDates.filter((d) => d.startsWith(monthPrefix));

      if (!selectedDates.length) {
        return res.status(400).json({
          success: false,
          message:
            "Tutor has no availability dates in this month for this class",
        });
      }
    } else {
      // fallback for other planTypes
      return res.status(400).json({
        success: false,
        message:
          "Scheduling supported only for 'hourly' and 'monthly' planType right now",
      });
    }

    // 🧹 Remove old sessions (if rescheduling)
    await Session.deleteMany({ regularClassId: rcId });

    // ✅ Create sessions from selected dates
    const sessionsToInsert = selectedDates.map((dateStr, idx) => {
      const startDateTime = buildDateTime(dateStr, time);

      const meetingLink = `https://meet.jit.si/tuitiontime-${rcId}-${idx}-${Date.now()}`;

      return {
        regularClassId: rc._id,
        studentId: rc.studentId,
        tutorId: rc.tutorId,
        startDateTime,
        meetingLink,
        status: "scheduled",
      };
    });

    const createdSessions = await Session.insertMany(sessionsToInsert);

    return res.json({
      success: true,
      message: "Sessions scheduled successfully from tutor availability",
      data: {
        planType: rc.planType,
        totalSessions: createdSessions.length,
        sessions: createdSessions,
      },
    });
  } catch (err) {
    console.error("scheduleRegularClassSessions error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
};
