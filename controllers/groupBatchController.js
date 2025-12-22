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
  return String(process.env.FEATURE_GROUP_BATCHES || "true").toLowerCase() === "true";
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
  const boards = Array.isArray(tp.boards) ? tp.boards : [];
  const availability = Array.isArray(tp.availability) ? tp.availability : [];
  const payload = {};

  const subject = String(body.subject || "").trim();
  if (!subject || !subjects.includes(subject)) errors.push("Invalid subject");
  payload.subject = subject;

  const rawBoard = body.board ? String(body.board).trim() : "";
  const boardOther = body.boardOther ? String(body.boardOther).trim() : "";
  let board = rawBoard;
  if (rawBoard === "Other" && boardOther) board = boardOther;
  if (board && boards.length && rawBoard !== "Other" && !boards.includes(board)) {
    errors.push("Invalid board");
  }
  if (rawBoard === "Other" && !boardOther) errors.push("boardOther is required");
  payload.board = board;

  const level = body.level ? String(body.level).trim() : undefined;
  if (level && !levels.includes(level)) errors.push("Invalid level");
  if (level) payload.level = level;

  const batchTypeRaw = String(body.batchType || "").trim();
  const batchType = batchTypeRaw === "normal" || batchTypeRaw === "exam"
    ? "normal class"
    : batchTypeRaw;
  if (!["revision", "normal class"].includes(batchType)) errors.push("Invalid batchType");
  payload.batchType = batchType;

  const seatCap = Number(body.seatCap);
  if (!Number.isFinite(seatCap) || seatCap < 2 || seatCap > 200) errors.push("Invalid seatCap");
  payload.seatCap = seatCap;

  // Price per student from payload (fallback to tutor profile if missing)
  const priceInput = body.pricePerMonth ?? body.pricePerStudent ?? tp.monthlyRate;
  const pricePerStudent = Number(priceInput);
  if (!Number.isFinite(pricePerStudent) || pricePerStudent <= 0) errors.push("Invalid price per month");
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

  // Class Start Time (HH:mm)
  const startTimeStr = String(body.classStartTime || "").trim();
  if (!startTimeStr.match(/^([01]?\d|2[0-3]):([0-5]\d)$/)) {
    errors.push("Invalid classStartTime");
  }

  // Start Date
  const startDate = new Date(body.startDate);
  if (isNaN(startDate.getTime()) || startDate < now) {
    errors.push("Invalid startDate (must be future)");
  }

  let endDate = null;
  if (body.endDate) {
    const endDateRaw = new Date(body.endDate);
    if (isNaN(endDateRaw.getTime())) {
      errors.push("Invalid endDate");
    } else if (endDateRaw < startDate) {
      errors.push("endDate must be on or after startDate");
    } else {
      endDate = endDateRaw;
    }
  }

  // Derive Recurring Days from Availability
  // Filter availability dates that are on or after startDate
  const futureAvailability = availability
    .map(d => new Date(d))
    .filter(d => !isNaN(d.getTime()) && d >= startDate);
  
  const uniqueDays = [...new Set(futureAvailability.map(d => toDayName(d)))];
  
  if (uniqueDays.length === 0) {
    errors.push("No available days found in profile on or after start date");
  }

  payload.scheduleType = "recurring";
  payload.recurring = {
    days: uniqueDays,
    time: startTimeStr,
    startDate: startDate,
    endDate: endDate
  };
  
  // Remove fixedDates logic
  payload.fixedDates = [];
  payload.endDate = endDate;

  if (errors.length > 0) {
    const err = new Error("Validation failed");
    err.status = 422;
    err.errors = errors;
    throw err;
  }
  return payload;
}

exports.createBatch = async (req, res) => {
  try {
    if (!featureEnabled()) return res.status(404).json({ success: false, message: "Feature disabled" });
    const tutorUserId = req.user.id;
    const TutorProfile = require("../models/TutorProfile");
    const tp = await TutorProfile.findOne({ userId: tutorUserId }).select("_id subjects classLevels boards availability isVerified monthlyRate");
    if (!tp) return res.status(404).json({ success: false, message: "Tutor profile not found" });
    if (!tp.isVerified) return res.status(403).json({ success: false, message: "Tutor not verified" });

    let payload;
    try {
      payload = validateBatchInput(tp, req.body || {});
    } catch (e) {
      if (e.status === 422) return res.status(422).json({ success: false, message: e.message, errors: e.errors });
      throw e;
    }

    const gb = await GroupBatch.create({
      tutorId: tp._id,
      subject: payload.subject,
      board: payload.board,
      level: payload.level,
      batchType: payload.batchType,
      scheduleType: "recurring",
      fixedDates: [],
      recurring: payload.recurring,
      seatCap: payload.seatCap,
      pricePerStudent: payload.pricePerStudent,
      meetingLink: payload.meetingLink,
      accessWindow: payload.accessWindow,
      description: payload.description,
      published: payload.published,
      batchStartDate: payload.recurring.startDate,
      batchEndDate: payload.endDate || null,
      enrollmentOpenAt: new Date(), // Open immediately
    });

    // Generate sessions for next 30 days
    const daysMap = { "Sun": 0, "Mon": 1, "Tue": 2, "Wed": 3, "Thu": 4, "Fri": 5, "Sat": 6 };
    const targetDays = (gb.recurring.days || []).map(d => daysMap[d]);
    const [startHour, startMinute] = gb.recurring.time.split(":").map(Number);
    
    let current = new Date(gb.recurring.startDate);
    const endLimit = new Date();
    endLimit.setDate(endLimit.getDate() + 30);
    if (gb.recurring?.endDate && gb.recurring.endDate < endLimit) {
      endLimit.setTime(new Date(gb.recurring.endDate).getTime());
    }
    
    const sessions = [];
    while (current <= endLimit) {
      if (targetDays.includes(current.getDay())) {
        const sessionDate = new Date(current);
        sessionDate.setHours(startHour, startMinute, 0, 0);
        // Only add if session is in the future
        if (sessionDate > Date.now()) {
            sessions.push({
              groupBatchId: gb._id,
              tutorId: gb.tutorId,
              startDateTime: sessionDate,
              meetingLink: `https://meet.jit.si/tuitiontime-${gb._id}-${sessions.length}-${Date.now()}`,
              status: "scheduled"
            });
        }
      }
      current.setDate(current.getDate() + 1);
    }
    
    if (sessions.length) await Session.insertMany(sessions);

    await createAdminNotification("Group batch created", `Batch ${gb._id} created`, { batchId: gb._id, tutorId: tp._id });
    metrics.emit("group.created", { batchId: gb._id });
    res.json({ success: true, data: gb });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

exports.getCreateOptions = async (req, res) => {
  try {
    if (!featureEnabled()) return res.status(404).json({ success: false, message: "Feature disabled" });
    const TutorProfile = require("../models/TutorProfile");
    const tp = await TutorProfile.findOne({ userId: req.user.id }).select("subjects classLevels boards availability monthlyRate");
    if (!tp) return res.status(404).json({ success: false, message: "Tutor profile not found" });
    const subjects = Array.isArray(tp.subjects) ? tp.subjects : [];
    const levels = Array.isArray(tp.classLevels) ? tp.classLevels : [];
    const boards = Array.isArray(tp.boards) ? tp.boards : [];
    const defaultBoards = ["CBSE", "ICSE", "State Board", "IB", "IGCSE"];
    const boardsOut = boards.length ? boards : defaultBoards;
    const availability = Array.isArray(tp.availability) ? tp.availability : [];
    
    // Normalize "now" to start of today so we include today's dates
    const now = new Date();
    now.setHours(0, 0, 0, 0);

    const futureDates = availability
      .map((x) => new Date(x))
      .filter((d) => !isNaN(d.getTime()) && d.getTime() >= now.getTime())
      .map((d) => d.toISOString());
    const batchTypes = ["revision", "normal class"];
    const scheduleTypes = ["recurring"];
    res.json({ success: true, data: { subjects, levels, boards: boardsOut, availabilityDates: futureDates, batchTypes, scheduleTypes, monthlyRate: tp.monthlyRate } });
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

    // Auto-sync: ensure a session exists for every fixed date (create missing)
    const desiredDates = (gb.fixedDates || [])
      .map((d) => new Date(d))
      .filter((d) => !isNaN(d.getTime()))
      .map((d) => d.toISOString());
    if (desiredDates.length) {
      const existingSessions = await Session.find({ groupBatchId: gb._id }).select("startDateTime").lean();
      const existingSet = new Set(existingSessions.map((s) => new Date(s.startDateTime).toISOString()));
      const toCreate = desiredDates.filter((iso) => !existingSet.has(iso));
      if (toCreate.length) {
        const payload = toCreate.map((iso, idx) => ({
          groupBatchId: gb._id,
          tutorId: gb.tutorId,
          startDateTime: new Date(iso),
          meetingLink: `https://meet.jit.si/tuitiontime-${gb._id}-${idx}-${Date.now()}`,
          status: "scheduled",
        }));
        await Session.insertMany(payload);
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

exports.myBatches = async (req, res) => {
  try {
    if (!featureEnabled()) return res.status(404).json({ success: false, message: "Feature disabled" });
    const tutorUserId = req.user.id;
    const TutorProfile = require("../models/TutorProfile");
    const tp = await TutorProfile.findOne({ userId: tutorUserId }).select("_id");
    if (!tp) return res.status(404).json({ success: false, message: "Tutor profile not found" });

    const items = await GroupBatch.find({ tutorId: tp._id }).sort({ createdAt: -1 }).lean();
    
    const now = Date.now();
    const data = items.map((b) => {
      const holdActiveCount = (b.holds || []).filter((h) => h.status === "active" && new Date(h.expiresAt).getTime() > now).length;
      const enrolledCount = (b.enrolled || []).length;
      const liveSeats = Math.max(0, Number(b.seatCap || 0) - enrolledCount - holdActiveCount);
      return { ...b, liveSeats };
    });

    res.json({ success: true, data });
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
    const tutorIds = items.map((b) => b.tutorId).filter(Boolean);
    let tutorMap = new Map();
    if (tutorIds.length) {
      const TutorProfile = require("../models/TutorProfile");
      const tutors = await TutorProfile.find({ _id: { $in: tutorIds } })
        .select("_id name photoUrl")
        .lean();
      tutorMap = new Map(tutors.map((t) => [String(t._id), t]));
    }
    let spId = null;
    let paymentsMap = {};
    try {
      const StudentProfile = require("../models/StudentProfile");
      const sp = await StudentProfile.findOne({ userId: req.user?.id }).select("_id");
      spId = sp?._id || null;
      
      if (spId && items.length > 0) {
        const Payment = require("../models/Payment");
        const batchIds = items.map(b => b._id);
        const payments = await Payment.find({
          studentId: spId,
          groupBatchId: { $in: batchIds },
          status: "paid",
          type: "group"
        }).select("groupBatchId _id");
        
        payments.forEach(p => {
          paymentsMap[String(p.groupBatchId)] = p._id;
        });
      }
    } catch (_) {}
    const data = items.map((b) => {
      const holdActiveCount = (b.holds || []).filter((h) => h.status === "active" && new Date(h.expiresAt).getTime() > now).length;
      const enrolledCount = (b.enrolled || []).length;
      const liveSeats = Math.max(0, Number(b.seatCap || 0) - enrolledCount - holdActiveCount);
      const isEnrolledForCurrentUser = spId ? (b.enrolled || []).some((s) => String(s) === String(spId)) : false;
      const hasActiveHoldForCurrentUser = spId ? (b.holds || []).some((h) => String(h.studentId) === String(spId) && h.status === "active" && new Date(h.expiresAt).getTime() > now) : false;
      const myPaymentId = paymentsMap[String(b._id)] || null;
      const tutor = tutorMap.get(String(b.tutorId)) || null;
      const batchTypeLabel = b.batchType === "normal class" || b.batchType === "normal" || b.batchType === "exam"
        ? "Normal Class"
        : b.batchType === "revision"
          ? "Revision"
          : b.batchType;
      return {
        ...b,
        liveSeats,
        isEnrolledForCurrentUser,
        hasActiveHoldForCurrentUser,
        myPaymentId,
        batchTypeLabel,
        tutor: tutor ? { id: tutor._id, name: tutor.name || "Tutor", photoUrl: tutor.photoUrl || null } : null,
      };
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

    let myEnrollment = null;
    try {
      if (req.user?.role === "student") {
        const StudentProfile = require("../models/StudentProfile");
        const sp = await StudentProfile.findOne({ userId: req.user.id }).select("_id");
        if (sp) {
          myEnrollment = (b.enrollmentDetails || []).find(ed => String(ed.studentId) === String(sp._id));
        }
      }
    } catch (_) {}

    res.json({ success: true, data: { ...b, liveSeats, myEnrollment } });
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
