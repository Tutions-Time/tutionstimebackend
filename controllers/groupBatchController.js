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

const { nanoid } = require("nanoid");

function toDayName(d) {
  const map = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return map[new Date(d).getDay()];
}

function validateBatchInput(tp, body) {
  const errors = [];
  const now = Date.now();
  const subjects = Array.isArray(tp.subjects) ? tp.subjects : [];
  const levels = Array.isArray(tp.classLevels) ? tp.classLevels : [];
  const availability = Array.isArray(tp.availability) ? tp.availability : [];
  const availableDays = availability.map(toDayName);
  const payload = {};

  const subject = String(body.subject || "").trim();
  if (!subject || !subjects.includes(subject)) errors.push("Invalid subject");
  payload.subject = subject;

  const level = body.level ? String(body.level).trim() : undefined;
  if (level && !levels.includes(level)) errors.push("Invalid level");
  if (level) payload.level = level;

  const batchType = String(body.batchType || "").trim();
  if (!["revision", "exam"].includes(batchType)) errors.push("Invalid batchType");
  payload.batchType = batchType;

  payload.scheduleType = "fixed";

  const seatCap = Number(body.seatCap);
  if (!Number.isFinite(seatCap) || seatCap < 2 || seatCap > 200) errors.push("Invalid seatCap");
  payload.seatCap = seatCap;

  const pricePerStudent = Number(body.pricePerStudent);
  if (!Number.isFinite(pricePerStudent) || pricePerStudent <= 0) errors.push("Invalid pricePerStudent");
  payload.pricePerStudent = pricePerStudent;

  const description = body.description ? String(body.description).trim() : "";
  if (description.length > 2000) errors.push("Description too long");
  payload.description = description;

  const accessWindow = body.accessWindow || {};
  const joinBeforeMin = Number(accessWindow.joinBeforeMin ?? 5);
  const expireAfterMin = Number(accessWindow.expireAfterMin ?? 5);
  if (joinBeforeMin < 0 || joinBeforeMin > 120) errors.push("Invalid joinBeforeMin");
  if (expireAfterMin < 0 || expireAfterMin > 240) errors.push("Invalid expireAfterMin");
  payload.accessWindow = { joinBeforeMin, expireAfterMin };

  const fixedDates = Array.isArray(body.fixedDates) ? body.fixedDates : [];
  const dates = fixedDates
    .map((d) => new Date(d))
    .filter((d) => !isNaN(d.getTime()) && d.getTime() > now)
    .map((d) => new Date(d.toISOString()));
  if (dates.length === 0) errors.push("No valid fixedDates");
  if (availability.length > 0) {
    const availSet = new Set(availability.map((x) => new Date(x).toISOString()));
    for (const d of dates) {
      if (!availSet.has(d.toISOString())) {
        errors.push("fixedDates must be from availability");
        break;
      }
    }
  }
  payload.fixedDates = Array.from(new Set(dates.map((d) => d.toISOString()))).map((s) => new Date(s));

  payload.meetingLink = `https://meet.jit.si/tuitiontime-${Math.random().toString(36).slice(2, 10)}`;

  const published = !!body.published;
  payload.published = published;

  if (errors.length) {
    const e = new Error("Validation failed");
    e.status = 422;
    e.errors = errors;
    throw e;
  }
  return payload;
}

exports.createBatch = async (req, res) => {
  try {
    if (!featureEnabled()) return res.status(404).json({ success: false, message: "Feature disabled" });
    const tutorUserId = req.user.id;
    const TutorProfile = require("../models/TutorProfile");
    const tp = await TutorProfile.findOne({ userId: tutorUserId }).select("_id subjects classLevels availability isVerified");
    if (!tp) return res.status(404).json({ success: false, message: "Tutor profile not found" });
    if (!tp.isVerified) return res.status(403).json({ success: false, message: "Tutor not verified" });

    const payload = validateBatchInput(tp, req.body || {});
    const gb = await GroupBatch.create({
      tutorId: tp._id,
      subject: payload.subject,
      level: payload.level,
      batchType: payload.batchType,
      scheduleType: "fixed",
      fixedDates: payload.fixedDates,
      recurring: undefined,
      seatCap: payload.seatCap,
      pricePerStudent: payload.pricePerStudent,
      meetingLink: payload.meetingLink,
      accessWindow: payload.accessWindow,
      description: payload.description,
      published: payload.published,
    });

    const existingSessions = await Session.countDocuments({ groupBatchId: gb._id });
    if (existingSessions === 0) {
      const sessions = (gb.fixedDates || []).map((d, idx) => ({
        groupBatchId: gb._id,
        tutorId: gb.tutorId,
        startDateTime: d,
        meetingLink: `https://meet.jit.si/tuitiontime-${gb._id}-${idx}-${Date.now()}`,
        status: "scheduled",
      }));
      if (sessions.length) await Session.insertMany(sessions);
    }

    await createAdminNotification("Group batch created", `Batch ${gb._id} created`, { batchId: gb._id, tutorId: tp._id });
    metrics.emit("group.created", { batchId: gb._id });
    res.json({ success: true, data: gb });
  } catch (err) {
    if (err && err.status === 422) return res.status(422).json({ success: false, message: err.message, errors: err.errors });
    res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

exports.getCreateOptions = async (req, res) => {
  try {
    if (!featureEnabled()) return res.status(404).json({ success: false, message: "Feature disabled" });
    const TutorProfile = require("../models/TutorProfile");
    const tp = await TutorProfile.findOne({ userId: req.user.id }).select("subjects classLevels availability");
    if (!tp) return res.status(404).json({ success: false, message: "Tutor profile not found" });
    const subjects = Array.isArray(tp.subjects) ? tp.subjects : [];
    const levels = Array.isArray(tp.classLevels) ? tp.classLevels : [];
    const availability = Array.isArray(tp.availability) ? tp.availability : [];
    const futureDates = availability
      .map((x) => new Date(x))
      .filter((d) => !isNaN(d.getTime()) && d.getTime() > Date.now())
      .map((d) => d.toISOString());
    const batchTypes = ["revision", "exam"];
    const scheduleTypes = ["fixed"];
    res.json({ success: true, data: { subjects, levels, availabilityDates: futureDates, batchTypes, scheduleTypes } });
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
    const wasPublished = !!gb.published;
    Object.assign(gb, update);

    if (!wasPublished && gb.published) {
      const dates = (gb.fixedDates || []).map((d) => new Date(d)).filter((d) => !isNaN(d.getTime()));
      if (dates.length) {
        dates.sort((a, b) => a.getTime() - b.getTime());
        gb.batchStartDate = dates[0];
        gb.batchEndDate = dates[dates.length - 1];
        gb.enrollmentOpenAt = gb.enrollmentOpenAt || new Date();
        gb.enrollmentCloseAt = gb.enrollmentCloseAt || new Date(dates[0].getTime());
      }
      const existing = await Session.countDocuments({ groupBatchId: gb._id });
      if (existing === 0) {
        const sessions = (gb.fixedDates || []).map((d, idx) => ({
          groupBatchId: gb._id,
          tutorId: gb.tutorId,
          startDateTime: d,
          meetingLink: `https://meet.jit.si/tuitiontime-${gb._id}-${idx}-${Date.now()}`,
          status: "scheduled",
        }));
        if (sessions.length) await Session.insertMany(sessions);
      }
    }

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
  console.log("listBatches", req.query);
  try {
    if (!featureEnabled()) return res.status(404).json({ success: false, message: "Feature disabled" });
    const { subject, level, date } = req.query;
    const q = { published: true, status: "active" };
    if (subject) q.subject = subject;
    if (level) q.level = level;
    let items = await GroupBatch.find(q).sort({ createdAt: -1 }).lean();
    if (date) {
      const d0 = new Date(date);
      const d1 = new Date(date);
      d1.setHours(23, 59, 59, 999);
      items = items.filter((b) => (b.fixedDates || []).some((fd) => {
        const dt = new Date(fd).getTime();
        return dt >= d0.getTime() && dt <= d1.getTime();
      }));
    }
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
        $or: [
          { enrollmentOpenAt: { $exists: false } },
          { enrollmentOpenAt: { $lte: now } }
        ],
        $or: [
          { enrollmentCloseAt: { $exists: false } },
          { enrollmentCloseAt: { $gte: now } }
        ],
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
    if (!b) {
      // minimal waitlist handling
      await GroupBatch.findOneAndUpdate(
        { _id: batchId, status: "active", published: true },
        { $addToSet: { waitlist: sp._id } }
      );
      return res.status(409).json({ success: false, message: "No seats available; added to waitlist" });
    }

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
    const existing = await Session.countDocuments({ groupBatchId: gb._id });
    if (existing > 0) return res.json({ success: true, count: existing });
    const sessions = (gb.fixedDates || []).map((d, idx) => ({
      groupBatchId: gb._id,
      tutorId: gb.tutorId,
      startDateTime: d,
      meetingLink: `https://meet.jit.si/tuitiontime-${gb._id}-${idx}-${Date.now()}`,
      status: "scheduled",
    }));
    const created = sessions.length ? await Session.insertMany(sessions) : [];
    await createAdminNotification("Batch sessions generated", `Generated ${created.length} sessions`, { batchId: gb._id });
    metrics.emit("group.sessions.generated", { batchId: gb._id }, { count: created.length });
    res.json({ success: true, count: created.length });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};
