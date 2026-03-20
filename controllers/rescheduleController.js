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
const TUTOR_RESCHEDULE_MIN_HOURS = Number(process.env.TUTOR_RESCHEDULE_MIN_HOURS || 24);

function parseProposedDateTime(date, time, mode = "regular") {
  const [y, m, d] = String(date || "").split("-").map(Number);
  const [hh, mm] = String(time || "").split(":").map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d) || !Number.isFinite(hh) || !Number.isFinite(mm)) {
    return null;
  }

  if (mode === "group") {
    // Group sessions are treated as IST wall-clock input.
    const yyyy = String(y).padStart(4, "0");
    const mon = String(m).padStart(2, "0");
    const day = String(d).padStart(2, "0");
    const hour = String(Math.max(0, Math.min(23, hh))).padStart(2, "0");
    const min = String(Math.max(0, Math.min(59, mm))).padStart(2, "0");
    const parsed = new Date(`${yyyy}-${mon}-${day}T${hour}:${min}:00+05:30`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  // Regular sessions keep legacy wall-clock behavior.
  const parsed = new Date(y, (m - 1), d, hh, mm, 0, 0);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function getComparableSessionStartDate(session) {
  const raw = new Date(session?.startDateTime);
  if (Number.isNaN(raw.getTime())) return null;

  // Regular sessions are stored as UTC wall-clock values.
  // Convert UTC components to local wall-clock for policy checks.
  if (session?.regularClassId && !session?.groupBatchId) {
    return new Date(
      raw.getUTCFullYear(),
      raw.getUTCMonth(),
      raw.getUTCDate(),
      raw.getUTCHours(),
      raw.getUTCMinutes(),
      raw.getUTCSeconds(),
      raw.getUTCMilliseconds()
    );
  }

  return raw;
}

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
    const isGroup = !!session.groupBatchId;
    const isRegular = !!session.regularClassId;
    if (!isGroup && !isRegular) {
      return res.status(400).json({ success: false, message: "Unsupported session type" });
    }
    const sessionStart = getComparableSessionStartDate(session);
    if (!sessionStart) {
      return res.status(400).json({ success: false, message: "Invalid session start time" });
    }
    if (sessionStart.getTime() <= Date.now()) {
      return res.status(400).json({ success: false, message: "Cannot reschedule past or ongoing sessions" });
    }

    const gb = isGroup ? await GroupBatch.findById(session.groupBatchId).lean() : null;
    const rc = isRegular ? await (await require("../models/RegularClass")).findById(session.regularClassId).lean() : null;
    if (isGroup && !gb) return res.status(404).json({ success: false, message: "Batch not found" });
    if (isRegular && !rc) return res.status(404).json({ success: false, message: "Regular class not found" });

    const proposed = parseProposedDateTime(date, time, isGroup ? "group" : "regular");
    if (!proposed) {
      return res.status(400).json({ success: false, message: "Invalid date or time" });
    }
    if (proposed.getTime() <= Date.now()) {
      return res.status(400).json({ success: false, message: "New time must be in the future" });
    }

    // Conflict validation against tutor's other classes
    const durationMin = isGroup ? (computeDurationMinutes(gb?.recurring?.time, gb?.recurring?.endTime) || 60) : (Number(process.env.REGULAR_SESSION_DURATION_MINUTES) || 60);
    const windowStart = new Date(proposed.getTime() - (durationMin - 1) * 60 * 1000);
    const windowEnd = new Date(proposed.getTime() + (durationMin - 1) * 60 * 1000);
    const overlapCount = await Session.countDocuments({
      tutorId: isGroup ? gb.tutorId : rc.tutorId,
      _id: { $ne: session._id },
      startDateTime: { $gte: windowStart, $lte: windowEnd },
      status: { $ne: "cancelled" },
    });
    if (overlapCount > 0) {
      return res.status(400).json({
        success: false,
        message: "Selected time conflicts with an existing class",
      });
    }

    // Use raw input for display everywhere to avoid timezone confusion
    const friendlyTime = `${String(date)} ${String(time)}`;

    if (role === "student") {
      return res.status(403).json({ success: false, message: "Students cannot reschedule classes" });
    }

    if (role === "tutor") {
      const tp = await TutorProfile.findOne({ userId }).select("_id").lean();
      const ownsGroup = isGroup ? (tp?._id && String(tp._id) === String(gb.tutorId)) : false;
      const ownsRegular = isRegular ? (tp?._id && String(rc.tutorId) === String(tp._id)) || String(rc.tutorId) === String(userId) : false;
      if (!(ownsGroup || ownsRegular)) {
        return res.status(403).json({ success: false, message: "Not authorized" });
      }

      const remainingMs = sessionStart.getTime() - Date.now();
      const minNoticeMs = TUTOR_RESCHEDULE_MIN_HOURS * 60 * 60 * 1000;
      if (remainingMs < minNoticeMs) {
        return res.status(400).json({
          success: false,
          message: `Tutor can reschedule only at least ${TUTOR_RESCHEDULE_MIN_HOURS} hours before class start`,
        });
      }

      // Group batch: apply reschedule immediately (no student approval required)
      if (isGroup) {
        const sessionDoc = await Session.findById(sessionId);
        if (!sessionDoc) {
          return res.status(404).json({ success: false, message: "Session not found" });
        }
        sessionDoc.startDateTime = proposed;
        try {
          const duration = computeDurationMinutes(gb?.recurring?.time, gb?.recurring?.endTime) || 60;
          const topic = buildGroupSessionTopic(gb, new Date(sessionDoc.startDateTime));
          const meeting = await zoomService.createZoomMeeting({
            topic,
            startTime: new Date(sessionDoc.startDateTime).toISOString(),
            duration,
          });
          sessionDoc.meetingId = meeting.id ? String(meeting.id) : sessionDoc.meetingId || "";
          sessionDoc.meetingPassword = meeting.password || meeting.encrypted_password || sessionDoc.meetingPassword || "";
          sessionDoc.startUrl = meeting.start_url || sessionDoc.startUrl || "";
          sessionDoc.joinUrl = meeting.join_url || sessionDoc.joinUrl || "";
          sessionDoc.meetingLink = meeting.join_url || sessionDoc.meetingLink || "";
        } catch (_) {}
        await sessionDoc.save();

        const r = await RescheduleRequest.create({
          sessionId,
          groupBatchId: session.groupBatchId || undefined,
          regularClassId: session.regularClassId || undefined,
          proposedStartDateTime: proposed,
          reason: reason || "",
          requesterUserId: userId,
          requesterRole: role,
          status: "approved",
          approverUserId: userId,
          approverRole: role,
          decisionAt: new Date(),
        });

        const studentUserIds = await getEnrolledStudentUserIds(session.groupBatchId);
        const targets = new Set([String(userId), ...studentUserIds.map(String)]);
        for (const uid of targets) {
          await notificationService.notifyUser(
            uid,
            "Class rescheduled",
            `New time: ${friendlyTime}`,
            {
              sessionId: sessionDoc._id,
              groupBatchId: session.groupBatchId,
              rescheduleRequestId: r._id,
              newStart: sessionDoc.startDateTime,
              date: String(date),
              time: String(time),
            }
          );
        }

        await AdminNotification.create({
          title: "Class rescheduled",
          message: `Tutor rescheduled group session to ${friendlyTime}`,
          meta: {
            sessionId: sessionDoc._id,
            groupBatchId: session.groupBatchId,
            rescheduleRequestId: r._id,
            newStart: sessionDoc.startDateTime,
            date: String(date),
            time: String(time),
          },
        });
        wsHub.sendToRole("admin", {
          type: "admin_notification",
          data: {
            title: "Class rescheduled",
            message: "Group batch session updated directly by tutor",
            meta: { sessionId: sessionDoc._id, groupBatchId: session.groupBatchId, rescheduleRequestId: r._id },
          },
        });

        return res.status(200).json({
          success: true,
          data: { sessionId: sessionDoc._id, newStart: sessionDoc.startDateTime, individual: false, autoApproved: true },
        });
      }

      // Regular class: keep approval workflow
      const r = await RescheduleRequest.create({
        sessionId,
        groupBatchId: session.groupBatchId || undefined,
        regularClassId: session.regularClassId || undefined,
        proposedStartDateTime: proposed,
        reason: reason || "",
        requesterUserId: userId,
        requesterRole: role,
        status: "pending",
      });
      // Notify approvers
      if (isGroup) {
        const studentUserIds = await getEnrolledStudentUserIds(session.groupBatchId);
        for (const sid of studentUserIds) {
          await notificationService.notifyUser(
            sid,
            "Reschedule requested",
            `Tutor proposed ${friendlyTime}`,
            { rescheduleRequestId: r._id, sessionId: session._id, groupBatchId: session.groupBatchId, newStart: r.proposedStartDateTime, date: String(date), time: String(time) }
          );
        }
      } else {
        const sp = await StudentProfile.findById(rc.studentId).select("userId").lean();
        if (sp?.userId) {
          await notificationService.notifyUser(
            sp.userId,
            "Reschedule requested",
            `Tutor proposed ${friendlyTime}`,
            { rescheduleRequestId: r._id, sessionId: session._id, regularClassId: session.regularClassId, newStart: r.proposedStartDateTime, date: String(date), time: String(time) }
          );
        }
      }
      await AdminNotification.create({
        title: "Reschedule requested",
        message: isGroup ? `Tutor proposed time for group session (${friendlyTime})` : `Tutor proposed time for regular class (${friendlyTime})`,
        meta: { sessionId: session._id, groupBatchId: session.groupBatchId, regularClassId: session.regularClassId, rescheduleRequestId: r._id, newStart: r.proposedStartDateTime, date: String(date), time: String(time) },
      });
      wsHub.sendToRole("admin", { type: "admin_notification", data: { title: "Reschedule requested", message: "Awaiting approvals", meta: { sessionId: session._id, groupBatchId: session.groupBatchId, regularClassId: session.regularClassId, rescheduleRequestId: r._id } } });
      return res.status(200).json({ success: true, data: r });
    } else {
      return res.status(403).json({ success: false, message: "Not allowed" });
    }
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

    // If student requested
    if (r.requesterRole === "student") {
      // Group student requests are not allowed by createRequest guard; handle regular classes here
      const duration = 60;
      // Update the existing regular session to the new time
      session.startDateTime = r.proposedStartDateTime;
      try {
        const meeting = await zoomService.createZoomMeeting({
          topic: `Regular Class - ${new Date(session.startDateTime).toLocaleString()}`,
          startTime: new Date(session.startDateTime).toISOString(),
          duration,
        });
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

      const tutorUserId = r.groupBatchId ? await getTutorUserIdFromBatch(r.groupBatchId) : (await TutorProfile.findById(session.tutorId).select("userId").lean())?.userId;
      const targets = new Set();
      if (tutorUserId) targets.add(String(tutorUserId));
      // Also notify the student themself for confirmation message
      if (r.requesterStudentId) {
        const sp = await StudentProfile.findById(r.requesterStudentId).select("userId").lean();
        if (sp?.userId) targets.add(String(sp.userId));
      }
      for (const uid of targets) {
        await notificationService.notifyUser(
          uid,
          "Reschedule approved",
          `New time: ${new Date(session.startDateTime).toLocaleString()}`,
          { sessionId: session._id, groupBatchId: r.groupBatchId, regularClassId: session.regularClassId, rescheduleRequestId: r._id, newStart: r.proposedStartDateTime }
        );
      }
      await AdminNotification.create({
        title: "Class rescheduled",
        message: "A regular class reschedule was approved",
        meta: { sessionId: session._id, groupBatchId: r.groupBatchId, regularClassId: session.regularClassId, rescheduleRequestId: r._id, newStart: r.proposedStartDateTime },
      });
      wsHub.sendToRole("admin", { type: "admin_notification", data: { title: "Class rescheduled", message: "Student reschedule approved", meta: { sessionId: session._id, groupBatchId: r.groupBatchId, regularClassId: session.regularClassId, rescheduleRequestId: r._id } } });
      return res.status(200).json({ success: true, data: { sessionId: session._id, newStart: session.startDateTime, individual: true } });
    } else {
      // Tutor-initiated approval path (fallback): reschedule class for everyone
      session.startDateTime = r.proposedStartDateTime;
      try {
        const duration = computeDurationMinutes(gb?.recurring?.time, gb?.recurring?.endTime) || 60;
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
          `New time: ${new Date(session.startDateTime).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`,
          { sessionId: session._id, groupBatchId: r.groupBatchId, rescheduleRequestId: r._id, newStart: r.proposedStartDateTime }
        );
      }
      await AdminNotification.create({
        title: "Class rescheduled",
        message: isGroup ? "A group batch session has been rescheduled" : "A regular class session has been rescheduled",
        meta: { sessionId: session._id, groupBatchId: r.groupBatchId, regularClassId: r.regularClassId, rescheduleRequestId: r._id, newStart: r.proposedStartDateTime },
      });
      wsHub.sendToRole("admin", { type: "admin_notification", data: { title: "Class rescheduled", message: "Session updated", meta: { sessionId: session._id, groupBatchId: r.groupBatchId, regularClassId: r.regularClassId, rescheduleRequestId: r._id } } });
      return res.status(200).json({ success: true, data: { sessionId: session._id, newStart: session.startDateTime, individual: false } });
    }
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
