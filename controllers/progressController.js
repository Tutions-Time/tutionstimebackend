const Session = require("../models/Session");
const RegularClass = require("../models/RegularClass");
const TutorProfile = require("../models/TutorProfile");

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
    .select("regularClassId status attendance notesUrl assignmentUrl recordingUrl startDateTime sessionFeedback")
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
    const sessions = classIds.length ? await getSessionsForClasses(classIds, from, to) : [];
    const completed = sessions.filter((s) => s.status === "completed");
    const present = sessions.filter((s) => s.attendance === "present");

    // rating from profile
    const tp = await TutorProfile.findOne({ userId }).select("rating ratingCount").lean();

    // rubric averages (only completed sessions with feedback)
    const withFeedback = completed.filter((s) => s.sessionFeedback && typeof s.sessionFeedback.teaching === "number");
    const avg = (arr, key) => {
      const vals = arr.map((x) => x.sessionFeedback[key]).filter((n) => typeof n === "number");
      if (!vals.length) return 0;
      return vals.reduce((a, b) => a + b, 0) / vals.length;
    };
    const rubricAverages = {
      teaching: avg(withFeedback, "teaching"),
      communication: avg(withFeedback, "communication"),
      understanding: avg(withFeedback, "understanding"),
    };

    // recent comments (latest 10 in window)
    const recentComments = withFeedback
      .map((s) => ({ c: (s.sessionFeedback.comment || "").trim(), t: s.sessionFeedback.createdAt || s.startDateTime }))
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

    if (String(session.regularClassId.studentId) !== String(userId)) {
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

    // Update tutor profile aggregate rating
    const tutorUserId = session.regularClassId.tutorId;
    const tp = await TutorProfile.findOne({ userId: tutorUserId });
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
          tutorId: session.regularClassId?.tutorId,
          overall,
        },
      });
      const tutorProfile = await TutorProfile.findOne({ userId: session.regularClassId.tutorId }).lean();
      if (tutorProfile?.email && notificationService?.sendEmail) {
        await notificationService.sendEmail(
          tutorProfile.email,
          "New class feedback received",
          "",
          `<p>You received new class feedback. Overall: ${overall}/5</p>`
        );
      }
      if (notificationService?.createInApp) {
        await notificationService.createInApp(session.regularClassId.tutorId, "New Feedback", `Overall ${overall}/5`, { sessionId: session._id });
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
    const sessions = classIds.length ? await getSessionsForClasses(classIds, from, to) : [];

    const completed = sessions.filter((s) => s.status === "completed");
    const present = sessions.filter((s) => s.attendance === "present");
    const withFeedback = completed.filter((s) => s.sessionFeedback && s.sessionFeedback.createdAt);

    const avg = (arr, key) => {
      const vals = arr.map((x) => x.sessionFeedback[key]).filter((n) => typeof n === "number");
      if (!vals.length) return 0;
      return vals.reduce((a, b) => a + b, 0) / vals.length;
    };

    const materials = {
      notes: completed.filter((s) => !!s.notesUrl).length,
      assignments: completed.filter((s) => !!s.assignmentUrl).length,
      recordings: completed.filter((s) => !!s.recordingUrl).length,
    };

    const topComments = withFeedback
      .map((s) => ({ c: (s.sessionFeedback.comment || "").trim(), t: s.sessionFeedback.createdAt || s.startDateTime }))
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
          teaching: avg(withFeedback, "teaching"),
          communication: avg(withFeedback, "communication"),
          understanding: avg(withFeedback, "understanding"),
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

