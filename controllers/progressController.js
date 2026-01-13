const Session = require("../models/Session");
const RegularClass = require("../models/RegularClass");
const TutorProfile = require("../models/TutorProfile");
const Booking = require("../models/Booking");

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function addDays(d, n) {
  return new Date(d.getTime() + n * 24 * 60 * 60 * 1000);
}

async function getStudentClasses(userId) {
  return RegularClass.find({ studentId: userId, paymentStatus: "paid", status: "active" })
    .select("_id subject tutorId")
    .lean();
}

async function getTutorClasses(userId) {
  return RegularClass.find({ tutorId: userId, paymentStatus: "paid", status: "active" })
    .select("_id subject studentId")
    .lean();
}

async function getSessionsForClasses(classIds, from, to) {
  return Session.find({
    regularClassId: { $in: classIds },
    startDateTime: { $gte: from, $lt: to },
  })
    .select("regularClassId groupBatchId tutorId status attendance notesUrl assignmentUrl recordingUrl startDateTime sessionFeedback")
    .lean();
}

async function getGroupSessionsForTutor(tutorUserId, from, to) {
  const TutorProfile = require("../models/TutorProfile");
  const tp = await TutorProfile.findOne({ userId: tutorUserId }).select("_id");
  const tutorProfileId = tp?._id;
  if (!tutorProfileId) return [];
  return Session.find({
    groupBatchId: { $ne: null },
    tutorId: tutorProfileId,
    startDateTime: { $gte: from, $lt: to },
  })
    .select("regularClassId groupBatchId tutorId status attendance notesUrl assignmentUrl recordingUrl startDateTime sessionFeedback")
    .lean();
}

exports.getStudentProgressSummary = async (req, res) => {
  try {
    const userId = req.user.id;
    const now = new Date();
    const to = addDays(startOfDay(now), 1);
    const from = addDays(startOfDay(now), -7);
    const prevFrom = addDays(from, -7);
    const prevTo = from;

    const classes = await getStudentClasses(userId);
    const classIds = classes.map((c) => c._id);
    const sessions = classIds.length ? await getSessionsForClasses(classIds, from, to) : [];
    const prevSessions = classIds.length ? await getSessionsForClasses(classIds, prevFrom, prevTo) : [];

    const completed = sessions.filter((s) => s.status === "completed");
    const present = sessions.filter((s) => s.attendance === "present");
    const assignments = completed.filter((s) => !!s.assignmentUrl);
    const notes = completed.filter((s) => !!s.notesUrl);
    const recordings = completed.filter((s) => !!s.recordingUrl);

    const prevCompleted = prevSessions.filter((s) => s.status === "completed").length;

    return res.json({
      success: true,
      data: {
        period: { from, to },
        totals: {
          sessions: sessions.length,
          completed: completed.length,
          attendanceRate: sessions.length ? Math.round((present.length / sessions.length) * 100) : 0,
          assignments: assignments.length,
          notes: notes.length,
          recordings: recordings.length,
        },
        deltas: {
          completedVsPrev: completed.length - prevCompleted,
        },
      },
    });
  } catch (err) {
    console.error("getStudentProgressSummary error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

exports.getStudentProgressBySubject = async (req, res) => {
  try {
    const userId = req.user.id;
    const now = new Date();
    const to = addDays(startOfDay(now), 1);
    const from = addDays(startOfDay(now), -30); // monthly breakdown

    const classes = await getStudentClasses(userId);
    const classIds = classes.map((c) => c._id);
    const subjectByClass = new Map(classes.map((c) => [String(c._id), c.subject]));

    const sessions = classIds.length ? await getSessionsForClasses(classIds, from, to) : [];

    const grouped = new Map();
    sessions.forEach((s) => {
      const subject = subjectByClass.get(String(s.regularClassId)) || "Unknown";
      const g = grouped.get(subject) || { sessions: 0, completed: 0, assignments: 0, notes: 0 };
      g.sessions += 1;
      if (s.status === "completed") g.completed += 1;
      if (s.assignmentUrl) g.assignments += 1;
      if (s.notesUrl) g.notes += 1;
      grouped.set(subject, g);
    });

    const data = Array.from(grouped.entries()).map(([subject, v]) => ({ subject, ...v }));
    return res.json({ success: true, data });
  } catch (err) {
    console.error("getStudentProgressBySubject error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

exports.getTutorProgressSummary = async (req, res) => {
  try {
    const userId = req.user.id;
    const now = new Date();
    const to = addDays(startOfDay(now), 1);
    const from = addDays(startOfDay(now), -7);

    const classes = await getTutorClasses(userId);
    const classIds = classes.map((c) => c._id);
    const regularSessions = classIds.length ? await getSessionsForClasses(classIds, from, to) : [];
    const groupSessions = await getGroupSessionsForTutor(userId, from, to);
    const sessions = [...regularSessions, ...groupSessions];
    const completed = sessions.filter((s) => s.status === "completed");
    const present = sessions.filter((s) => s.attendance === "present");

    // rating from profile
    const tp = await TutorProfile.findOne({ userId }).select("rating ratingCount").lean();

    // rubric averages (completed sessions + demo feedback in window)
    const withFeedback = completed.filter((s) => s.sessionFeedback && typeof s.sessionFeedback.teaching === "number");
    const demoBookings = await Booking.find({
      tutorId: userId,
      "demoFeedback.createdAt": { $gte: from, $lt: to },
    })
      .select("demoFeedback createdAt")
      .lean();

    const sessionFeedbackItems = withFeedback.map((s) => ({
      ...s.sessionFeedback,
      createdAt: s.sessionFeedback.createdAt || s.startDateTime,
    }));
    const demoFeedbackItems = demoBookings
      .map((b) =>
        b.demoFeedback
          ? { ...b.demoFeedback, createdAt: b.demoFeedback.createdAt || b.createdAt }
          : null
      )
      .filter(Boolean);
    const feedbackItems = [...sessionFeedbackItems, ...demoFeedbackItems];

    const avg = (arr, key) => {
      const vals = arr.map((x) => x[key]).filter((n) => typeof n === "number");
      if (!vals.length) return 0;
      return vals.reduce((a, b) => a + b, 0) / vals.length;
    };
    const rubricAverages = {
      teaching: avg(feedbackItems, "teaching"),
      communication: avg(feedbackItems, "communication"),
      understanding: avg(feedbackItems, "understanding"),
    };

    // recent comments (latest 10 in window)
    const recentComments = feedbackItems
      .map((s) => ({ c: (s.comment || "").trim(), t: s.createdAt }))
      .filter((x) => !!x.c)
      .sort((a, b) => new Date(b.t).getTime() - new Date(a.t).getTime())
      .slice(0, 10)
      .map((x) => x.c);

    // materials uploaded counts
    const materials = {
      notes: completed.filter((s) => !!s.notesUrl).length,
      assignments: completed.filter((s) => !!s.assignmentUrl).length,
      recordings: completed.filter((s) => !!s.recordingUrl).length,
    };

    return res.json({
      success: true,
      data: {
        period: { from, to },
        totals: {
          sessions: sessions.length,
          completed: completed.length,
          attendanceConsistency: sessions.length ? Math.round((present.length / sessions.length) * 100) : 0,
          averageRating: tp?.rating || 0,
          ratingCount: tp?.ratingCount || 0,
        },
        rubricAverages,
        recentComments,
        materials,
      },
    });
  } catch (err) {
    console.error("getTutorProgressSummary error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

const AdminNotification = require("../models/AdminNotification");
const notificationService = require("../services/notificationService");

exports.giveSessionFeedback = async (req, res) => {
  try {
    const sessionId = req.params.id;
    const { teaching, communication, understanding, comment } = req.body;
    const userId = req.user.id;

    if (!teaching || !communication || !understanding) {
      return res.status(400).json({ success: false, message: "teaching, communication, understanding are required" });
    }

    const isValidScore = (n) => Number.isFinite(n) && n >= 1 && n <= 5;
    if (![teaching, communication, understanding].every(isValidScore)) {
      return res.status(400).json({ success: false, message: "Scores must be integers between 1 and 5" });
    }

    const safeComment = (comment || "").toString().trim().slice(0, 500);

    const session = await Session.findById(sessionId).populate("regularClassId");
    if (!session) return res.status(404).json({ success: false, message: "Session not found" });

    // Authorize student membership for both regular class and group batch sessions
    const StudentProfile = require("../models/StudentProfile");
    const GroupBatch = require("../models/GroupBatch");
    const sp = await StudentProfile.findOne({ userId }).select("_id");
    const studentProfileId = sp?._id || userId;

    let authorized = false;
    if (session.groupBatchId) {
      const gb = await GroupBatch.findById(session.groupBatchId).select("enrolled");
      authorized = !!gb && (gb.enrolled || []).some((s) => String(s) === String(studentProfileId));
    } else if (session.regularClassId) {
      authorized = String(session.regularClassId.studentId) === String(studentProfileId);
    }
    if (!authorized) {
      return res.status(403).json({ success: false, message: "Not authorized for this session" });
    }

    if (session.status !== "completed") {
      return res.status(400).json({ success: false, message: "Feedback allowed only after completion" });
    }

    if (session.sessionFeedback && session.sessionFeedback.createdAt) {
      return res.status(400).json({ success: false, message: "Feedback already submitted" });
    }

    const overall = Math.round((teaching + communication + understanding) / 3);
    session.sessionFeedback = {
      teaching,
      communication,
      understanding,
      overall,
      comment: safeComment,
      createdAt: new Date(),
    };
    await session.save();

    // Update tutor profile aggregate rating (supports group batch and regular)
    const tutorProfileId = session.groupBatchId ? session.tutorId : session.regularClassId?.tutorId;
    const tp = tutorProfileId ? await TutorProfile.findById(tutorProfileId) : null;
    if (tp) {
      tp.ratingSum = (tp.ratingSum || 0) + overall;
      tp.ratingCount = (tp.ratingCount || 0) + 1;
      tp.rating = tp.ratingSum / Math.max(tp.ratingCount, 1);
      await tp.save();
    }

    try {
      await AdminNotification.create({
        title: "Session feedback submitted",
        message: `Feedback for session ${session._id}`,
        meta: {
          sessionId: session._id,
          regularClassId: session.regularClassId?._id,
          studentId: userId,
          tutorId: tutorProfileId,
          overall,
        },
      });
      const tutorProfile = tutorProfileId ? await TutorProfile.findById(tutorProfileId).lean() : null;
      if (tutorProfile?.email && notificationService?.sendEmail) {
        await notificationService.sendEmail(
          tutorProfile.email,
          "New class feedback received",
          "",
          `<p>You received new class feedback. Overall: ${overall}/5</p>`
        );
      }
      if (notificationService?.createInApp) {
        if (tutorProfileId) {
          await notificationService.createInApp(tutorProfileId, "New Feedback", `Overall ${overall}/5`, { sessionId: session._id });
        }
      }
    } catch {}

    return res.json({ success: true, message: "Feedback submitted", data: session.sessionFeedback });
  } catch (err) {
    console.error("giveSessionFeedback error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

exports.getTutorWeeklySummary = async (req, res) => {
  try {
    const userId = req.user.id;
    const now = new Date();
    const to = addDays(startOfDay(now), 1);
    const from = addDays(startOfDay(now), -7);

    const classes = await getTutorClasses(userId);
    const classIds = classes.map((c) => c._id);
    const regularSessions = classIds.length ? await getSessionsForClasses(classIds, from, to) : [];
    const groupSessions = await getGroupSessionsForTutor(userId, from, to);
    const sessions = [...regularSessions, ...groupSessions];

    const completed = sessions.filter((s) => s.status === "completed");
    const present = sessions.filter((s) => s.attendance === "present");
    const withFeedback = completed.filter((s) => s.sessionFeedback && s.sessionFeedback.createdAt);
    const demoBookings = await Booking.find({
      tutorId: userId,
      "demoFeedback.createdAt": { $gte: from, $lt: to },
    })
      .select("demoFeedback createdAt")
      .lean();

    const sessionFeedbackItems = withFeedback.map((s) => ({
      ...s.sessionFeedback,
      createdAt: s.sessionFeedback.createdAt || s.startDateTime,
    }));
    const demoFeedbackItems = demoBookings
      .map((b) =>
        b.demoFeedback
          ? { ...b.demoFeedback, createdAt: b.demoFeedback.createdAt || b.createdAt }
          : null
      )
      .filter(Boolean);
    const feedbackItems = [...sessionFeedbackItems, ...demoFeedbackItems];

    const avg = (arr, key) => {
      const vals = arr.map((x) => x[key]).filter((n) => typeof n === "number");
      if (!vals.length) return 0;
      return vals.reduce((a, b) => a + b, 0) / vals.length;
    };

    const materials = {
      notes: completed.filter((s) => !!s.notesUrl).length,
      assignments: completed.filter((s) => !!s.assignmentUrl).length,
      recordings: completed.filter((s) => !!s.recordingUrl).length,
    };

    const topComments = feedbackItems
      .map((s) => ({ c: (s.comment || "").trim(), t: s.createdAt }))
      .filter((x) => !!x.c)
      .sort((a, b) => new Date(b.t).getTime() - new Date(a.t).getTime())
      .slice(0, 10)
      .map((x) => x.c);

    return res.json({
      success: true,
      data: {
        period: { from, to },
        sessions: sessions.length,
        completed: completed.length,
        attendanceConsistency: sessions.length ? Math.round((present.length / sessions.length) * 100) : 0,
        rubricAverages: {
          teaching: avg(feedbackItems, "teaching"),
          communication: avg(feedbackItems, "communication"),
          understanding: avg(feedbackItems, "understanding"),
        },
        materials,
        topComments,
      },
    });
  } catch (err) {
    console.error("getTutorWeeklySummary error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

exports.getStudentWeeklySummary = async (req, res) => {
  try {
    const userId = req.user.id;
    const now = new Date();
    const to = addDays(startOfDay(now), 1);
    const from = addDays(startOfDay(now), -7);

    const classes = await getStudentClasses(userId);
    const classIds = classes.map((c) => c._id);
    const sessions = classIds.length ? await getSessionsForClasses(classIds, from, to) : [];
    const completed = sessions.filter((s) => s.status === "completed");
    const present = sessions.filter((s) => s.attendance === "present");

    const materials = {
      notes: completed.filter((s) => !!s.notesUrl).length,
      assignments: completed.filter((s) => !!s.assignmentUrl).length,
      recordings: completed.filter((s) => !!s.recordingUrl).length,
    };

    const comments = completed
      .filter((s) => s.sessionFeedback && s.sessionFeedback.comment)
      .map((s) => (s.sessionFeedback.comment || "").trim())
      .slice(0, 10);

    return res.json({
      success: true,
      data: {
        period: { from, to },
        sessions: sessions.length,
        completed: completed.length,
        attendanceRate: sessions.length ? Math.round((present.length / sessions.length) * 100) : 0,
        materials,
        comments,
      },
    });
  } catch (err) {
    console.error("getStudentWeeklySummary error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

exports.getStudentTimeSpentSummary = async (req, res) => {
  try {
    const userId = req.user.id;
    const now = new Date();
    const to = addDays(startOfDay(now), 1);
    const days = Number(req.query.days || 7);
    const from = addDays(startOfDay(now), -Math.max(1, days));
    const classes = await getStudentClasses(userId);
    const classIds = classes.map((c) => c._id);
    const subjectByClass = new Map(classes.map((c) => [String(c._id), c.subject]));
    const sessions = classIds.length ? await getSessionsForClasses(classIds, from, to) : [];
    let totalMinutes = 0;
    const bySubject = new Map();
    for (const s of sessions) {
      const start = s.studentJoinTime ? new Date(s.studentJoinTime).getTime() : null;
      const end = s.studentLeaveTime ? new Date(s.studentLeaveTime).getTime() : null;
      const dur = start && end && end > start ? Math.round((end - start) / 60000) : 0;
      totalMinutes += dur;
      const subject = subjectByClass.get(String(s.regularClassId)) || "Unknown";
      const v = bySubject.get(subject) || 0;
      bySubject.set(subject, v + dur);
    }
    const data = Array.from(bySubject.entries()).map(([subject, minutes]) => ({ subject, minutes }));
    return res.json({ success: true, data: { totalMinutes, bySubject: data, period: { from, to }, days } });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

exports.getTutorRatingTrend = async (req, res) => {
  try {
    const userId = req.user.id;
    const weeks = Math.max(1, Number(req.query.weeks || 8));
    const now = new Date();
    const from = addDays(startOfDay(now), -(weeks * 7));
    const to = addDays(startOfDay(now), 1);
    const classes = await getTutorClasses(userId);
    const classIds = classes.map((c) => c._id);
    const regularSessions = classIds.length ? await getSessionsForClasses(classIds, from, to) : [];
    const hasScore = (x) => x && typeof x === "number";
    const dataPoints = [];
    for (const s of regularSessions) {
      const when = s.sessionFeedback && s.sessionFeedback.createdAt ? new Date(s.sessionFeedback.createdAt) : s.startDateTime ? new Date(s.startDateTime) : null;
      const score = s.sessionFeedback ? s.sessionFeedback.overall : null;
      if (!when || !hasScore(score)) continue;
      const d = new Date(when);
      const day = d.getDay();
      const diff = (day + 6) % 7;
      const weekStart = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
      weekStart.setUTCDate(weekStart.getUTCDate() - diff);
      weekStart.setUTCHours(0, 0, 0, 0);
      dataPoints.push({ key: weekStart.toISOString().slice(0, 10), val: score });
    }
    const Booking = require("../models/Booking");
    const demoBookings = await Booking.find({ tutorId: userId, "demoFeedback.createdAt": { $gte: from, $lt: to } }).select("demoFeedback createdAt").lean();
    for (const b of demoBookings) {
      const when = b.demoFeedback && b.demoFeedback.createdAt ? new Date(b.demoFeedback.createdAt) : new Date(b.createdAt);
      const score = b.demoFeedback ? b.demoFeedback.overall : null;
      if (!hasScore(score)) continue;
      const d = new Date(when);
      const day = d.getDay();
      const diff = (day + 6) % 7;
      const weekStart = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
      weekStart.setUTCDate(weekStart.getUTCDate() - diff);
      weekStart.setUTCHours(0, 0, 0, 0);
      dataPoints.push({ key: weekStart.toISOString().slice(0, 10), val: score });
    }
    const grouped = new Map();
    for (const p of dataPoints) {
      const g = grouped.get(p.key) || { sum: 0, count: 0 };
      g.sum += Number(p.val || 0);
      g.count += 1;
      grouped.set(p.key, g);
    }
    const series = Array.from(grouped.entries())
      .map(([k, v]) => ({ weekStart: k, avgOverall: v.count ? Math.round((v.sum / v.count) * 100) / 100 : 0, count: v.count }))
      .sort((a, b) => new Date(a.weekStart).getTime() - new Date(b.weekStart).getTime());
    return res.json({ success: true, data: { series, period: { from, to } } });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

exports.getTutorRetention = async (req, res) => {
  try {
    const userId = req.user.id;
    const now = new Date();
    const from30 = addDays(startOfDay(now), -30);
    const from60 = addDays(startOfDay(now), -60);
    const from90 = addDays(startOfDay(now), -90);
    const to = addDays(startOfDay(now), 1);
    const Booking = require("../models/Booking");
    const RegularClass = require("../models/RegularClass");
    const Session = require("../models/Session");
    const conversions30 = await Booking.countDocuments({ tutorId: userId, type: "demo", regularClassId: { $ne: null }, createdAt: { $gte: from30, $lt: to } });
    const conversions90 = await Booking.countDocuments({ tutorId: userId, type: "demo", regularClassId: { $ne: null }, createdAt: { $gte: from90, $lt: to } });
    const tpClasses = await RegularClass.find({ tutorId: userId, status: "active", paymentStatus: "paid" }).select("_id").lean();
    const classIds = tpClasses.map((c) => c._id);
    const sess30 = classIds.length ? await Session.find({ regularClassId: { $in: classIds }, startDateTime: { $gte: from30, $lt: to } }).select("studentId").lean() : [];
    const byStudent30 = new Map();
    for (const s of sess30) {
      if (!s.studentId) continue;
      const k = String(s.studentId);
      byStudent30.set(k, (byStudent30.get(k) || 0) + 1);
    }
    const repeatStudents30 = Array.from(byStudent30.values()).filter((n) => n >= 2).length;
    const prev30 = classIds.length ? await Session.find({ regularClassId: { $in: classIds }, startDateTime: { $gte: from60, $lt: from30 } }).select("studentId").lean() : [];
    const prevSet = new Set(prev30.filter((x) => x.studentId).map((x) => String(x.studentId)));
    const lastSet = new Set(sess30.filter((x) => x.studentId).map((x) => String(x.studentId)));
    const base = prevSet.size || 1;
    let returning = 0;
    for (const id of prevSet) {
      if (lastSet.has(id)) returning += 1;
    }
    const retention30 = Math.round((returning / base) * 100);
    return res.json({ success: true, data: { conversion30d: conversions30, conversion90d: conversions90, repeatStudents30d: repeatStudents30, retention30d: retention30 } });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

