const Session = require("../models/Session");
const GroupBatch = require("../models/GroupBatch");
const RescheduleRequest = require("../models/RescheduleRequest");
const StudentProfile = require("../models/StudentProfile");
const TutorProfile = require("../models/TutorProfile");
const AdminNotification = require("../models/AdminNotification");
const notificationService = require("../services/notificationService");
const zoomService = require("../services/zoomService");
const { computeDurationMinutes, buildGroupSessionTopic } = require("../utils/sessionZoomUtils");
const wsHub = require("../services/wsHub");

async function getTutorUserIdFromBatch(batchId) {
  const gb = await GroupBatch.findById(batchId).select("tutorId").lean();
  if (!gb?.tutorId) return null;
  const tp = await TutorProfile.findById(gb.tutorId).select("userId").lean();
  return tp?.userId || null;
}

async function getEnrolledStudentUserIds(batchId) {
  const gb = await GroupBatch.findById(batchId).select("enrolled enrollmentDetails").lean();
  const ids = new Set();
  if (gb?.enrollmentDetails && Array.isArray(gb.enrollmentDetails)) {
    for (const e of gb.enrollmentDetails) {
      if (e?.studentId) {
        const sp = await StudentProfile.findById(e.studentId).select("userId").lean();
        if (sp?.userId) ids.add(String(sp.userId));
      }
    }
  }
  if (gb?.enrolled && Array.isArray(gb.enrolled) && gb.enrolled.length > 0) {
    const sps = await StudentProfile.find({ _id: { $in: gb.enrolled } }).select("userId").lean();
    for (const sp of sps) {
      if (sp?.userId) ids.add(String(sp.userId));
    }
  }
  return Array.from(ids);
}

exports.createRequest = async (req, res) => {
  try {
    const sessionId = req.params.id;
    const { date, time, reason } = req.body || {};
    const role = req.user.role;
    const userId = req.user.id;

    const session = await Session.findById(sessionId).lean();
    if (!session) {
      return res.status(404).json({ success: false, message: "Session not found" });
    }
    if (!session.groupBatchId) {
      return res.status(400).json({ success: false, message: "Only group batch sessions are supported" });
    }
    if (new Date(session.startDateTime).getTime() <= Date.now()) {
      return res.status(400).json({ success: false, message: "Cannot reschedule past or ongoing sessions" });
    }

    const gb = await GroupBatch.findById(session.groupBatchId).lean();
    if (!gb) {
      return res.status(404).json({ success: false, message: "Batch not found" });
    }

    const [y, m, d] = String(date || "").split("-").map(Number);
    const [hh, mm] = String(time || "").split(":").map(Number);
    if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d) || !Number.isFinite(hh) || !Number.isFinite(mm)) {
      return res.status(400).json({ success: false, message: "Invalid date or time" });
    }
    const proposed = new Date(Date.UTC(y, (m - 1), d, hh, mm, 0, 0));
    if (proposed.getTime() <= Date.now()) {
      return res.status(400).json({ success: false, message: "New time must be in the future" });
    }

    if (role === "student") {
      const sp = await StudentProfile.findOne({ userId }).select("_id").lean();
      if (!sp?._id) return res.status(403).json({ success: false, message: "Student profile not found" });
      const gbFull = await GroupBatch.findById(gb._id).select("enrollmentDetails").lean();
      const enrolled = (gbFull?.enrollmentDetails || []).some(e => String(e.studentId) === String(sp._id));
      if (!enrolled) return res.status(403).json({ success: false, message: "Not enrolled in this batch" });
    } else if (role === "tutor") {
      const tp = await TutorProfile.findOne({ userId }).select("_id").lean();
      if (!tp?._id || String(tp._id) !== String(gb.tutorId)) {
        return res.status(403).json({ success: false, message: "Not authorized" });
      }
    } else {
      return res.status(403).json({ success: false, message: "Not allowed" });
    }

    const existing = await RescheduleRequest.findOne({ sessionId, status: "pending" }).lean();
    if (existing) {
      return res.status(400).json({ success: false, message: "A pending request already exists for this session" });
    }

    const r = await RescheduleRequest.create({
      sessionId,
      groupBatchId: session.groupBatchId,
      proposedStartDateTime: proposed,
      reason: reason || "",
      requesterUserId: userId,
      requesterRole: role,
      status: "pending",
    });

    const tutorUserId = await getTutorUserIdFromBatch(session.groupBatchId);
    if (role === "student") {
      if (tutorUserId) {
        await notificationService.notifyUser(
          tutorUserId,
          "Reschedule requested",
          "A student requested to reschedule a group class",
          { rescheduleRequestId: r._id, sessionId: session._id, groupBatchId: session.groupBatchId, newStart: r.proposedStartDateTime }
        );
      }
    } else {
      const studentUserIds = await getEnrolledStudentUserIds(session.groupBatchId);
      for (const sid of studentUserIds) {
        await notificationService.notifyUser(
          sid,
          "Reschedule proposed",
          "Tutor proposed new time for a group class",
          { rescheduleRequestId: r._id, sessionId: session._id, groupBatchId: session.groupBatchId, newStart: r.proposedStartDateTime }
        );
      }
    }

    await AdminNotification.create({
      title: "Reschedule requested",
      message: "A reschedule request was created for a group session",
      meta: { rescheduleRequestId: r._id, sessionId: session._id, groupBatchId: session.groupBatchId, role },
    });
    wsHub.sendToRole("admin", { type: "admin_notification", data: { title: "Reschedule requested", message: "Pending approval", meta: { rescheduleRequestId: r._id, sessionId: session._id, groupBatchId: session.groupBatchId } } });

    res.status(200).json({ success: true, data: r });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message || "Server error" });
  }
};

exports.listMine = async (req, res) => {
  try {
    const role = req.user.role;
    const userId = req.user.id;
    let filter = {};
    if (role === "student") {
      filter = {
        status: "pending",
        $or: [
          { requesterUserId: userId },
          { groupBatchId: { $in: (await GroupBatch.find({ "enrollmentDetails.studentId": (await StudentProfile.findOne({ userId }).select("_id"))._id }).select("_id")).map(b => b._id) } }
        ]
      };
    } else if (role === "tutor") {
      const tp = await TutorProfile.findOne({ userId }).select("_id").lean();
      const batchIds = await GroupBatch.find({ tutorId: tp?._id }).select("_id").lean();
      filter = {
        status: "pending",
        $or: [{ requesterUserId: userId }, { groupBatchId: { $in: batchIds.map(b => b._id) } }],
      };
    } else {
      filter = { status: "pending" };
    }
    const items = await RescheduleRequest.find(filter).sort({ createdAt: -1 }).lean();
    res.status(200).json({ success: true, data: items });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error" });
  }
};

exports.approve = async (req, res) => {
  try {
    const id = req.params.id;
    const role = req.user.role;
    const userId = req.user.id;

    const r = await RescheduleRequest.findById(id);
    if (!r) return res.status(404).json({ success: false, message: "Request not found" });
    if (r.status !== "pending") return res.status(400).json({ success: false, message: "Request is not pending" });

    const session = await Session.findById(r.sessionId);
    if (!session) return res.status(404).json({ success: false, message: "Session not found" });
    const gb = await GroupBatch.findById(r.groupBatchId);
    if (!gb) return res.status(404).json({ success: false, message: "Batch not found" });

    let allowed = false;
    if (r.requesterRole === "student" && role === "tutor") {
      const tp = await TutorProfile.findOne({ userId }).select("_id");
      if (tp?._id && String(tp._id) === String(gb.tutorId)) allowed = true;
    } else if (r.requesterRole === "tutor" && role === "student") {
      const sp = await StudentProfile.findOne({ userId }).select("_id");
      const gbFull = await GroupBatch.findById(gb._id).select("enrollmentDetails");
      const enrolled = (gbFull?.enrollmentDetails || []).some(e => String(e.studentId) === String(sp?._id));
      if (enrolled) allowed = true;
    }
    if (!allowed) return res.status(403).json({ success: false, message: "Not authorized to approve" });

    session.startDateTime = r.proposedStartDateTime;
    try {
      const duration = computeDurationMinutes(gb?.recurring?.time, gb?.recurring?.endTime);
      const topic = buildGroupSessionTopic(gb.toObject ? gb.toObject() : gb, new Date(session.startDateTime));
      const meeting = await zoomService.createZoomMeeting({ topic, startTime: new Date(session.startDateTime).toISOString(), duration });
      session.meetingId = meeting.id ? String(meeting.id) : session.meetingId || "";
      session.meetingPassword = meeting.password || meeting.encrypted_password || session.meetingPassword || "";
      session.startUrl = meeting.start_url || session.startUrl || "";
      session.joinUrl = meeting.join_url || session.joinUrl || "";
      session.meetingLink = meeting.join_url || session.meetingLink || "";
    } catch (_) {}
    await session.save();

    r.status = "approved";
    r.approverUserId = userId;
    r.approverRole = role;
    r.decisionAt = new Date();
    await r.save();

    const tutorUserId = await getTutorUserIdFromBatch(r.groupBatchId);
    const studentUserIds = await getEnrolledStudentUserIds(r.groupBatchId);
    const targets = new Set();
    if (tutorUserId) targets.add(String(tutorUserId));
    for (const sid of studentUserIds) targets.add(String(sid));
    for (const uid of targets) {
      await notificationService.notifyUser(
        uid,
        "Class rescheduled",
        "A group class has been rescheduled",
        { sessionId: session._id, groupBatchId: r.groupBatchId, rescheduleRequestId: r._id, newStart: r.proposedStartDateTime }
      );
    }
    await AdminNotification.create({
      title: "Class rescheduled",
      message: "A group batch session has been rescheduled",
      meta: { sessionId: session._id, groupBatchId: r.groupBatchId, rescheduleRequestId: r._id, newStart: r.proposedStartDateTime },
    });
    wsHub.sendToRole("admin", { type: "admin_notification", data: { title: "Class rescheduled", message: "Group session updated", meta: { sessionId: session._id, groupBatchId: r.groupBatchId, rescheduleRequestId: r._id } } });

    res.status(200).json({ success: true, data: { sessionId: session._id, newStart: session.startDateTime } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message || "Server error" });
  }
};

exports.reject = async (req, res) => {
  try {
    const id = req.params.id;
    const role = req.user.role;
    const userId = req.user.id;
    const r = await RescheduleRequest.findById(id);
    if (!r) return res.status(404).json({ success: false, message: "Request not found" });
    if (r.status !== "pending") return res.status(400).json({ success: false, message: "Request is not pending" });

    const gb = await GroupBatch.findById(r.groupBatchId).select("tutorId");
    if (!gb) return res.status(404).json({ success: false, message: "Batch not found" });

    let allowed = false;
    if (r.requesterRole === "student" && role === "tutor") {
      const tp = await TutorProfile.findOne({ userId }).select("_id");
      if (tp?._id && String(tp._id) === String(gb.tutorId)) allowed = true;
    } else if (r.requesterRole === "tutor" && role === "student") {
      const sp = await StudentProfile.findOne({ userId }).select("_id");
      const gbFull = await GroupBatch.findById(gb._id).select("enrollmentDetails");
      const enrolled = (gbFull?.enrollmentDetails || []).some(e => String(e.studentId) === String(sp?._id));
      if (enrolled) allowed = true;
    }
    if (!allowed) return res.status(403).json({ success: false, message: "Not authorized to reject" });

    r.status = "rejected";
    r.approverUserId = userId;
    r.approverRole = role;
    r.decisionAt = new Date();
    await r.save();

    const tutorUserId = await getTutorUserIdFromBatch(r.groupBatchId);
    const studentUserIds = await getEnrolledStudentUserIds(r.groupBatchId);
    const targets = new Set();
    if (tutorUserId) targets.add(String(tutorUserId));
    for (const sid of studentUserIds) targets.add(String(sid));
    for (const uid of targets) {
      await notificationService.notifyUser(
        uid,
        "Reschedule rejected",
        "A reschedule request was rejected",
        { rescheduleRequestId: r._id, sessionId: r.sessionId, groupBatchId: r.groupBatchId }
      );
    }
    await AdminNotification.create({
      title: "Reschedule rejected",
      message: "A reschedule request was rejected",
      meta: { rescheduleRequestId: r._id, sessionId: r.sessionId, groupBatchId: r.groupBatchId },
    });
    wsHub.sendToRole("admin", { type: "admin_notification", data: { title: "Reschedule rejected", message: "Request closed", meta: { rescheduleRequestId: r._id, sessionId: r.sessionId, groupBatchId: r.groupBatchId } } });

    res.status(200).json({ success: true, data: r });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message || "Server error" });
  }
};

