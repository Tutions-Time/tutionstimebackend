const RegularClass = require("../../models/RegularClass");
const Session = require("../../models/Session");
const TutorProfile = require("../../models/TutorProfile");
const StudentProfile = require("../../models/StudentProfile");
const notificationService = require("../notificationService");
const AdminNotification = require("../../models/AdminNotification");
const emailTpl = require("../../templates/emailTemplates");

function startOfDay(d) { const x = new Date(d); x.setHours(0,0,0,0); return x; }
function addDays(d, n) { return new Date(d.getTime() + n * 86400000); }

async function studentMonthlySummary(userId) {
  const now = new Date();
  const to = addDays(startOfDay(now), 1);
  const from = addDays(startOfDay(now), -30);
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

async function getTutorClassIds(userId) {
  const tp = await TutorProfile.findOne({ userId }).select("_id").lean();
  const tutorIds = [userId];
  if (tp?._id) tutorIds.push(tp._id);

  const classes = await RegularClass.find({ tutorId: { $in: tutorIds } })
    .select("_id")
    .lean();

  return { tutorIds, classIds: classes.map(c => c._id) };
}

async function tutorHasAnyClass(userId) {
  const { tutorIds, classIds } = await getTutorClassIds(userId);
  if (classIds.length) return true;

  const session = await Session.exists({ tutorId: { $in: tutorIds } });
  return Boolean(session);
}

async function tutorMonthlySummary(userId) {
  const now = new Date();
  const to = addDays(startOfDay(now), 1);
  const from = addDays(startOfDay(now), -30);
  const { tutorIds } = await getTutorClassIds(userId);
  const classes = await RegularClass.find({ tutorId: { $in: tutorIds }, paymentStatus: "paid", status: "active" })
    .select("_id")
    .lean();
  const classIds = classes.map(c => c._id);
  const sessions = classIds.length ? await Session.find({
    regularClassId: { $in: classIds }, startDateTime: { $gte: from, $lt: to }
  }).lean() : [];
  const completed = sessions.filter(s => s.status === "completed").length;
  const present = sessions.filter(s => s.attendance === "present").length;
  const tp = await TutorProfile.findOne({ userId }).select("rating ratingCount").lean();
  const withFeedback = sessions.filter(s => s.status === "completed" && s.sessionFeedback && typeof s.sessionFeedback.overall === "number");
  const avg = (arr, key) => {
    const vals = arr.map(x => x.sessionFeedback[key]).filter(n => typeof n === "number");
    return vals.length ? vals.reduce((a,b)=>a+b,0)/vals.length : 0;
  };
  const rubricAverages = {
    teaching: avg(withFeedback, "teaching"),
    communication: avg(withFeedback, "communication"),
    understanding: avg(withFeedback, "understanding"),
  };
  const materials = {
    notes: sessions.filter(s => s.status === "completed" && !!s.notesUrl).length,
    assignments: sessions.filter(s => s.status === "completed" && !!s.assignmentUrl).length,
    recordings: sessions.filter(s => s.status === "completed" && !!s.recordingUrl).length,
  };
  const topComments = withFeedback
    .map(s => ({ c: (s.sessionFeedback.comment||"").trim(), t: s.sessionFeedback.createdAt || s.startDateTime }))
    .filter(x => !!x.c)
    .sort((a,b)=>new Date(b.t).getTime()-new Date(a.t).getTime())
    .slice(0,5)
    .map(x=>x.c);
  return { sessions: sessions.length, completed, attendanceConsistency: sessions.length ? Math.round((present/sessions.length)*100) : 0, averageRating: tp?.rating || 0, ratingCount: tp?.ratingCount || 0, rubricAverages, materials, topComments };
}

async function sendMonthlyReports() {
  try {
    const now = new Date();
    const date = now.getDate();
    const hour = now.getHours();
    if (!(date === 1 && hour === 8)) return; // run on the 1st of each month at 08:00 local

    const students = await StudentProfile.find({}).select("userId name email").lean();
    for (const s of students) {
      const sum = await studentMonthlySummary(s.userId);
      if (s.email && notificationService?.sendEmail) {
        const html = emailTpl.monthlySummaryHTML({
          title: "Your Monthly Learning Summary",
          message: "Here is your learning activity for the last 30 days.",
          rows: [
            { label: "Sessions", value: sum.sessions },
            { label: "Completed", value: sum.completed },
            { label: "Attendance", value: `${sum.attendanceRate}%` },
            { label: "Assignments received", value: sum.assignments },
          ],
        });
        await notificationService.sendEmail(s.email, "Monthly Summary - tuitionstime", "", html);
      }
      try {
        await AdminNotification.create({ title: "Monthly summary sent (student)", message: `Sent to ${s.name}`, meta: { userId: s.userId, ...sum } });
        if (notificationService?.createInApp) {
          await notificationService.createInApp(s.userId, "Monthly Summary", `Sessions ${sum.sessions}, Completed ${sum.completed}`, { type: "monthly", period: "30d" });
        }
      } catch {}
    }

    const tutors = await TutorProfile.find({}).select("userId name email").lean();
    for (const t of tutors) {
      if (!(await tutorHasAnyClass(t.userId))) continue;

      const sum = await tutorMonthlySummary(t.userId);
      if (t.email && notificationService?.sendEmail) {
        const html = emailTpl.monthlySummaryHTML({
          title: "Your Monthly Teaching Summary",
          message: "Here is your teaching activity for the last 30 days.",
          rows: [
            { label: "Sessions", value: sum.sessions },
            { label: "Completed", value: sum.completed },
            { label: "Attendance consistency", value: `${sum.attendanceConsistency}%` },
            { label: "Average rating", value: `${sum.averageRating.toFixed(1)} (${sum.ratingCount})` },
            { label: "Rubric averages", value: `T ${sum.rubricAverages.teaching.toFixed(1)}, C ${sum.rubricAverages.communication.toFixed(1)}, U ${sum.rubricAverages.understanding.toFixed(1)}` },
            { label: "Materials uploaded", value: `Notes ${sum.materials.notes}, Assignments ${sum.materials.assignments}, Recordings ${sum.materials.recordings}` },
            { label: "Recent comments", value: sum.topComments.join(" | ") },
          ],
        });
        await notificationService.sendEmail(t.email, "Monthly Summary - tuitionstime", "", html);
      }
      if (notificationService?.createInApp) {
        await notificationService.createInApp(t.userId, "Monthly Summary", `Sessions ${sum.sessions}, Completed ${sum.completed}, Rating ${sum.averageRating.toFixed(1)}`, { type: "monthly", period: "30d" });
      }
      try {
        await AdminNotification.create({ title: "Monthly summary sent (tutor)", message: `Sent to ${t.name}`, meta: { userId: t.userId, ...sum } });
      } catch {}
    }
  } catch (err) {
    console.error("monthlyReportScheduler error:", err);
  }
}

exports.start = function start() {
  // check hourly to reduce chances of missing exact time
  setInterval(sendMonthlyReports, 60 * 60 * 1000);
};

