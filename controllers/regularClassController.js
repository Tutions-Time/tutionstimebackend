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
        planType: rc.planType,     
        startDate: rc.startDate,
        paymentStatus: rc.paymentStatus,
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

    // Check Tutor Ownership
    if (rc.tutorId.toString() !== tutorUserId) {
      return res.status(403).json({
        success: false,
        message: "Not authorized",
      });
    }

    // Ensure payment is completed
    if (rc.paymentStatus !== "paid" || rc.status !== "active") {
      return res.status(400).json({
        success: false,
        message: "Regular class is not active & paid yet",
      });
    }

    // Load Tutor Availability
    const tutorProfile = await TutorProfile.findOne({ userId: tutorUserId }).lean();
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
      const n = rc.classCount; // 💥 Use classCount stored earlier

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
      const monthPrefix = rc.startDate.toISOString().slice(0, 7); // "YYYY-MM"
      selectedDates = futureDates.filter((d) => d.startsWith(monthPrefix));

      if (!selectedDates.length) {
        return res.status(400).json({
          success: false,
          message: "No availability for this month",
        });
      }
    }

    else {
      return res.status(400).json({
        success: false,
        message: "PlanType must be hourly or monthly",
      });
    }

    // ------------------------------
    // 🧹 Clear old sessions
    // ------------------------------
    await Session.deleteMany({ regularClassId: rcId });

    // ------------------------------
    // 🧪 Create Sessions Automatically
    // ------------------------------
    const sessionsToInsert = selectedDates.map((dateStr, idx) => {
      const startDateTime = buildDateTime(dateStr, time);

      return {
        regularClassId: rc._id,
        studentId: rc.studentId,
        tutorId: rc.tutorId,
        startDateTime,
        meetingLink: `https://meet.jit.si/tuitiontime-${rcId}-${idx}-${Date.now()}`,
        status: "scheduled",
      };
    });

    const created = await Session.insertMany(sessionsToInsert);

    rc.scheduleStatus = "scheduled";
    await rc.save();

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

