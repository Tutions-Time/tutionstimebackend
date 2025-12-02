const RegularClass = require("../../models/RegularClass");
const Session = require("../../models/Session");
const TutorProfile = require("../../models/TutorProfile");
const StudentProfile = require("../../models/StudentProfile");
const notificationService = require("../notificationService");

function startOfDay(d) { const x = new Date(d); x.setHours(0,0,0,0); return x; }
function addDays(d, n) { return new Date(d.getTime() + n * 86400000); }

async function studentWeeklySummary(userId) {
  const now = new Date();
  const to = addDays(startOfDay(now), 1);
  const from = addDays(startOfDay(now), -7);
  const classes = await RegularClass.find({ studentId: userId, paymentStatus: "paid", status: "active" })
    .select("_id subject")
    .lean();
  const classIds = classes.map(c => c._id);
  const sessions = classIds.length ? await Session.find({
    regularClassId: { $in: classIds }, startDateTime: { $gte: from, $lt: to }
  }).lean() : [];
  const completed = sessions.filter(s => s.status === "completed").length;
  const present = sessions.filter(s => s.attendance === "present").length;
  const assignments = sessions.filter(s => s.status === "completed" && s.assignmentUrl).length;
  return { sessions: sessions.length, completed, attendanceRate: sessions.length ? Math.round((present/sessions.length)*100) : 0, assignments };
}

async function tutorWeeklySummary(userId) {
  const now = new Date();
  const to = addDays(startOfDay(now), 1);
  const from = addDays(startOfDay(now), -7);
  const classes = await RegularClass.find({ tutorId: userId, paymentStatus: "paid", status: "active" })
    .select("_id")
    .lean();
  const classIds = classes.map(c => c._id);
  const sessions = classIds.length ? await Session.find({
    regularClassId: { $in: classIds }, startDateTime: { $gte: from, $lt: to }
  }).lean() : [];
  const completed = sessions.filter(s => s.status === "completed").length;
  const present = sessions.filter(s => s.attendance === "present").length;
  const tp = await TutorProfile.findOne({ userId }).select("rating ratingCount").lean();
  return { sessions: sessions.length, completed, attendanceConsistency: sessions.length ? Math.round((present/sessions.length)*100) : 0, averageRating: tp?.rating || 0, ratingCount: tp?.ratingCount || 0 };
}

async function sendWeeklyReports() {
  try {
    const now = new Date();
    const day = now.getDay(); // 1 = Monday
    const hour = now.getHours();
    if (!(day === 1 && hour === 8)) return; // run at Monday 08:00 local

    const students = await StudentProfile.find({}).select("userId name email").lean();
    for (const s of students) {
      const sum = await studentWeeklySummary(s.userId);
      if (s.email && notificationService?.sendEmail) {
        const html = `<h3>Your Weekly Learning Summary</h3><p>Sessions: ${sum.sessions}</p><p>Completed: ${sum.completed}</p><p>Attendance: ${sum.attendanceRate}%</p><p>Assignments received: ${sum.assignments}</p>`;
        await notificationService.sendEmail(s.email, "Weekly Summary - TuitionTime", "", html);
      }
    }

    const tutors = await TutorProfile.find({}).select("userId name email").lean();
    for (const t of tutors) {
      const sum = await tutorWeeklySummary(t.userId);
      if (t.email && notificationService?.sendEmail) {
        const html = `<h3>Your Weekly Teaching Summary</h3><p>Sessions: ${sum.sessions}</p><p>Completed: ${sum.completed}</p><p>Attendance consistency: ${sum.attendanceConsistency}%</p><p>Avg rating: ${sum.averageRating.toFixed(1)} (${sum.ratingCount})</p>`;
        await notificationService.sendEmail(t.email, "Weekly Summary - TuitionTime", "", html);
      }
    }
  } catch (err) {
    console.error("weeklyReportScheduler error:", err);
  }
}

exports.start = function start() {
  // check hourly to reduce chances of missing exact time
  setInterval(sendWeeklyReports, 60 * 60 * 1000);
};

