const GroupBatch = require("../models/GroupBatch");
const Session = require("../models/Session");
const { createAdminNotification } = require("../services/adminNotification");
const metrics = require("../services/metricsService");

function computeRefundPolicy(gb) {
  const now = Date.now();
  const firstDate = gb.scheduleType === "fixed" ? (gb.fixedDates || []).map((d) => new Date(d).getTime()).sort()[0] : (gb.recurring?.startDate ? new Date(gb.recurring.startDate).getTime() : now);
  const preStart = now < firstDate;
  return preStart ? { eligible: true, percent: 80 } : { eligible: false, percent: 0 };
}
const notificationService = require("../services/notificationService");

function featureEnabled() {
  return String(process.env.FEATURE_GROUP_BATCHES || "false").toLowerCase() === "true";
}

exports.createBatch = async (req, res) => {
  try {
    if (!featureEnabled()) return res.status(404).json({ success: false, message: "Feature disabled" });
    const tutorUserId = req.user.id;
    const TutorProfile = require("../models/TutorProfile");
    const tp = await TutorProfile.findOne({ userId: tutorUserId }).select("_id");
    if (!tp) return res.status(404).json({ success: false, message: "Tutor profile not found" });

    const {
      subject,
      level,
      batchType,
      scheduleType,
      fixedDates,
      recurring,
      seatCap,
      pricePerStudent,
      meetingLink,
      accessWindow,
      description,
      published,
    } = req.body;

    const gb = await GroupBatch.create({
      tutorId: tp._id,
      subject,
      level,
      batchType,
      scheduleType,
      fixedDates: fixedDates || [],
      recurring: recurring || undefined,
      seatCap,
      pricePerStudent,
      meetingLink,
      accessWindow,
      description,
      published: !!published,
    });

    await createAdminNotification("Group batch created", `Batch ${gb._id} created`, { batchId: gb._id, tutorId: tp._id });
    metrics.emit("group.created", { batchId: gb._id });
    res.json({ success: true, data: gb });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

exports.editBatch = async (req, res) => {
  try {
    if (!featureEnabled()) return res.status(404).json({ success: false, message: "Feature disabled" });
    const id = req.params.id;
    const tutorUserId = req.user.id;
    const TutorProfile = require("../models/TutorProfile");
    const tp = await TutorProfile.findOne({ userId: tutorUserId }).select("_id");
    const gb = await GroupBatch.findById(id);
    if (!gb) return res.status(404).json({ success: false, message: "Batch not found" });
    if (!tp || String(gb.tutorId) !== String(tp._id)) return res.status(403).json({ success: false, message: "Not authorized" });

    const update = req.body || {};
    Object.assign(gb, update);
    await gb.save();
    await createAdminNotification("Group batch updated", `Batch ${gb._id} updated`, { batchId: gb._id });
    metrics.emit("group.updated", { batchId: gb._id });
    res.json({ success: true, data: gb });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

exports.cancelBatch = async (req, res) => {
  try {
    if (!featureEnabled()) return res.status(404).json({ success: false, message: "Feature disabled" });
    const id = req.params.id;
    const tutorUserId = req.user.id;
    const TutorProfile = require("../models/TutorProfile");
    const tp = await TutorProfile.findOne({ userId: tutorUserId }).select("_id");
    const gb = await GroupBatch.findById(id);
    if (!gb) return res.status(404).json({ success: false, message: "Batch not found" });
    if (!tp || String(gb.tutorId) !== String(tp._id)) return res.status(403).json({ success: false, message: "Not authorized" });
  gb.status = "cancelled";
  gb.published = false;
  await gb.save();
  await createAdminNotification("Group batch cancelled", `Batch ${gb._id} cancelled`, { batchId: gb._id });
  const User = require("../models/User");
  const studentUsers = await User.find({ _id: { $in: gb.enrolled } }).select("_id");
  for (const u of studentUsers) {
    await notificationService.createInApp(u._id, "Batch cancelled", "Your group batch was cancelled", { batchId: gb._id });
  }
  const policy = computeRefundPolicy(gb);
  await createAdminNotification("Refund policy evaluated", `Batch ${gb._id} refund: ${policy.percent}%`, { batchId: gb._id, policy });
  if (policy.eligible) metrics.incrementRefund(gb._id);
  res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

exports.rescheduleBatch = async (req, res) => {
  try {
    if (!featureEnabled()) return res.status(404).json({ success: false, message: "Feature disabled" });
    const id = req.params.id;
    const tutorUserId = req.user.id;
    const TutorProfile = require("../models/TutorProfile");
    const tp = await TutorProfile.findOne({ userId: tutorUserId }).select("_id");
    const gb = await GroupBatch.findById(id);
    if (!gb) return res.status(404).json({ success: false, message: "Batch not found" });
    if (!tp || String(gb.tutorId) !== String(tp._id)) return res.status(403).json({ success: false, message: "Not authorized" });
    const update = req.body || {};
    Object.assign(gb, update);
    await gb.save();
    await createAdminNotification("Group batch rescheduled", `Batch ${gb._id} rescheduled`, { batchId: gb._id });
    res.json({ success: true, data: gb });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

exports.listBatches = async (req, res) => {
  try {
    if (!featureEnabled()) return res.status(404).json({ success: false, message: "Feature disabled" });
    const { subject, level, date } = req.query;
    const q = { published: true, status: "active" };
    if (subject) q.subject = subject;
    if (level) q.level = level;
    const items = await GroupBatch.find(q).sort({ createdAt: -1 }).lean();
    const now = Date.now();
    const data = items.map((b) => {
      const holdActive = (b.holds || []).filter((h) => h.status === "active" && new Date(h.expiresAt).getTime() > now).length;
      const enrolledCount = (b.enrolled || []).length;
      const liveSeats = Math.max(0, Number(b.seatCap || 0) - enrolledCount - holdActive);
      return { ...b, liveSeats };
    });
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

exports.getBatch = async (req, res) => {
  try {
    if (!featureEnabled()) return res.status(404).json({ success: false, message: "Feature disabled" });
    const id = req.params.id;
    const b = await GroupBatch.findById(id).lean();
    if (!b) return res.status(404).json({ success: false, message: "Batch not found" });
    const now = Date.now();
    const holdActive = (b.holds || []).filter((h) => h.status === "active" && new Date(h.expiresAt).getTime() > now).length;
    const enrolledCount = (b.enrolled || []).length;
    const liveSeats = Math.max(0, Number(b.seatCap || 0) - enrolledCount - holdActive);
    res.json({ success: true, data: { ...b, liveSeats } });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

exports.joinBatch = async (req, res) => {
  try {
    if (!featureEnabled()) return res.status(404).json({ success: false, message: "Feature disabled" });
    const batchId = req.params.id;
    const userId = req.user.id;
    const StudentProfile = require("../models/StudentProfile");
    const sp = await StudentProfile.findOne({ userId }).select("_id");
    if (!sp) return res.status(404).json({ success: false, message: "Student profile not found" });
    const now = new Date();
    const ttlMin = Number(process.env.GROUP_SEAT_HOLD_TTL_MIN || 15);
    const expires = new Date(now.getTime() + ttlMin * 60 * 1000);

    const b = await GroupBatch.findOneAndUpdate(
      {
        _id: batchId,
        status: "active",
        published: true,
        $expr: {
          $gt: [
            "$seatCap",
            { $add: [ { $size: "$enrolled" }, { $size: { $filter: { input: "$holds", as: "h", cond: { $and: [ { $eq: ["$$h.status", "active"] }, { $gt: ["$$h.expiresAt", now] } ] } } } } ] }
          ]
        }
      },
      { $push: { holds: { studentId: sp._id, expiresAt: expires } } },
      { new: true }
    );
    if (!b) return res.status(409).json({ success: false, message: "No seats available" });

    const hold = (b.holds || []).find((h) => String(h.studentId) === String(sp._id) && h.status === "active" && new Date(h.expiresAt).getTime() >= now.getTime());
    await createAdminNotification("Seat reserved", `Hold created for batch ${batchId}`, { batchId, studentId: sp._id });
    metrics.emit("group.hold", { batchId }, { ttlMin });
    res.json({ success: true, reservationId: `${batchId}:${sp._id}`, expiresAt: expires });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

exports.leaveBatch = async (req, res) => {
  try {
    if (!featureEnabled()) return res.status(404).json({ success: false, message: "Feature disabled" });
    const batchId = req.params.id;
    const userId = req.user.id;
    const StudentProfile = require("../models/StudentProfile");
    const sp = await StudentProfile.findOne({ userId }).select("_id");
    if (!sp) return res.status(404).json({ success: false, message: "Student profile not found" });

    const b = await GroupBatch.findById(batchId);
    if (!b) return res.status(404).json({ success: false, message: "Batch not found" });

  b.enrolled = (b.enrolled || []).filter((s) => String(s) !== String(sp._id));
    b.holds = (b.holds || []).map((h) => {
      if (String(h.studentId) === String(sp._id) && h.status === "active") h.status = "released";
      return h;
    });
  await b.save();
  const policy = computeRefundPolicy(b);
  await createAdminNotification("Leave batch", `Student left batch ${batchId}, refund ${policy.percent}%`, { batchId, studentId: sp._id, policy });
  if (policy.eligible) metrics.incrementRefund(batchId);

    const next = (b.waitlist || []).shift();
    if (next) {
      const ttlMin = Number(process.env.GROUP_SEAT_HOLD_TTL_MIN || 15);
      const expires = new Date(Date.now() + ttlMin * 60 * 1000);
      await GroupBatch.updateOne({ _id: batchId }, { $push: { holds: { studentId: next, expiresAt: expires } }, $set: { waitlist: b.waitlist } });
      await createAdminNotification("Waitlist promoted", `Student promoted for batch ${batchId}`, { batchId, studentId: next });
      metrics.emit("group.waitlist.promoted", { batchId });
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

exports.listBatchSessions = async (req, res) => {
  try {
    if (!featureEnabled()) return res.status(404).json({ success: false, message: "Feature disabled" });
    const batchId = req.params.id;
    const items = await Session.find({ groupBatchId: batchId }).sort({ startDateTime: 1 }).lean();
    res.json({ success: true, data: items });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

exports.getRoster = async (req, res) => {
  try {
    if (!featureEnabled()) return res.status(404).json({ success: false, message: "Feature disabled" });
    const batchId = req.params.id;
    const gb = await GroupBatch.findById(batchId).populate({ path: 'enrolled', select: 'name userId' }).lean();
    if (!gb) return res.status(404).json({ success: false, message: "Batch not found" });
    res.json({ success: true, data: gb.enrolled || [] });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

exports.broadcastAnnouncement = async (req, res) => {
  try {
    if (!featureEnabled()) return res.status(404).json({ success: false, message: "Feature disabled" });
    const batchId = req.params.id;
    const { title, body } = req.body;
    const gb = await GroupBatch.findById(batchId).select('enrolled');
    if (!gb) return res.status(404).json({ success: false, message: "Batch not found" });
    const User = require("../models/User");
    const users = await User.find({ _id: { $in: gb.enrolled } }).select('_id');
    for (const u of users) {
      await notificationService.createInApp(u._id, title, body, { batchId });
    }
    await createAdminNotification("Batch announcement", `Broadcast to ${users.length} students`, { batchId });
    res.json({ success: true, count: users.length });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

exports.generateUpcomingSessions = async (req, res) => {
  try {
    if (!featureEnabled()) return res.status(404).json({ success: false, message: "Feature disabled" });
    const batchId = req.params.id;
    const gb = await GroupBatch.findById(batchId);
    if (!gb) return res.status(404).json({ success: false, message: "Batch not found" });
    const sessions = [];
    if (gb.scheduleType === "fixed") {
      for (const d of gb.fixedDates || []) {
        sessions.push({ groupBatchId: gb._id, tutorId: gb.tutorId, startDateTime: d, meetingLink: gb.meetingLink });
      }
    } else {
      const days = gb.recurring?.days || [];
      const time = gb.recurring?.time || "";
      const start = gb.recurring?.startDate ? new Date(gb.recurring.startDate) : new Date();
      const end = gb.recurring?.endDate ? new Date(gb.recurring.endDate) : new Date(start.getTime() + 30 * 24 * 60 * 60 * 1000);
      const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
      let cur = new Date(start);
      while (cur <= end) {
        const dayName = Object.keys(dayMap).find((k) => dayMap[k] === cur.getDay());
        if (days.includes(dayName)) {
          const [hh, mm] = String(time).split(":");
          const dt = new Date(cur);
          if (hh) dt.setHours(Number(hh));
          if (mm) dt.setMinutes(Number(mm));
          dt.setSeconds(0);
          sessions.push({ groupBatchId: gb._id, tutorId: gb.tutorId, startDateTime: dt, meetingLink: gb.meetingLink });
        }
        cur = new Date(cur.getTime() + 24 * 60 * 60 * 1000);
      }
    }
    const created = await Session.insertMany(sessions.map((s) => ({ ...s })));
    await createAdminNotification("Batch sessions generated", `Generated ${created.length} sessions`, { batchId: gb._id });
    metrics.emit("group.sessions.generated", { batchId: gb._id }, { count: created.length });
    res.json({ success: true, count: created.length });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};
