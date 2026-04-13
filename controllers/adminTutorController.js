const mongoose = require('mongoose');
const User = require('../models/User');
const TutorProfile = require('../models/TutorProfile');
const Booking = require('../models/Booking');
const Session = require('../models/Session');
const Payment = require('../models/Payment');
const GroupBatch = require('../models/GroupBatch');
const RegularClass = require('../models/RegularClass');
const Note = require('../models/Note');
const Transaction = require('../models/Transaction');
const StudentProfile = require('../models/StudentProfile');

const KYC_STATUSES = ['pending', 'submitted', 'approved', 'rejected'];

function hasPayoutDetails(profile) {
  return Boolean(
    profile?.upiId &&
      profile?.accountHolderName &&
      profile?.bankAccountNumber &&
      profile?.ifsc
  );
}

function hasKycDocuments(profile) {
  return Boolean(profile?.aadhaarUrls?.length && profile?.panUrl);
}

// ✅ Get all tutors with joined KYC and performance info
exports.getAllTutors = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      q = '',
      kyc = 'all',
      status = 'all',
      minRating = 0,
      sort = 'joined_desc',
    } = req.query;

    const pageNum = Math.max(1, Number(page));
    const limitNum = Math.max(1, Math.min(100, Number(limit)));
    const skip = Math.max(0, (pageNum - 1) * limitNum);
    const search = String(q || '').trim();
    const ratingMin = Math.max(0, Number(minRating) || 0);

    const match = { role: 'tutor' };
    if (status !== 'all') match.status = status;

    const pipeline = [
      { $match: match },
      {
        $lookup: {
          from: 'tutorprofiles',
          localField: '_id',
          foreignField: 'userId',
          as: 'profile',
        },
      },
      { $addFields: { profile: { $arrayElemAt: ['$profile', 0] } } },
    ];

    if (search) {
      const regex = new RegExp(search, 'i');
      pipeline.push({
        $match: {
          $or: [
            { phone: { $regex: regex } },
            { 'profile.name': { $regex: regex } },
            { 'profile.email': { $regex: regex } },
          ],
        },
      });
    }

    if (kyc !== 'all') {
      pipeline.push({ $match: { 'profile.kycStatus': kyc } });
    }

    if (ratingMin > 0) {
      pipeline.push({ $match: { 'profile.rating': { $gte: ratingMin } } });
    }

    pipeline.push({
      $addFields: {
        ratingSort: { $ifNull: ['$profile.rating', 0] },
        nameSort: { $ifNull: ['$profile.name', ''] },
      },
    });

    let sortStage = { createdAt: -1 };
    if (sort === 'joined_asc') sortStage = { createdAt: 1 };
    if (sort === 'rating_desc') sortStage = { ratingSort: -1 };
    if (sort === 'rating_asc') sortStage = { ratingSort: 1 };
    if (sort === 'name_asc') sortStage = { nameSort: 1 };
    if (sort === 'name_desc') sortStage = { nameSort: -1 };

    const [result] = await User.aggregate([
      ...pipeline,
      {
        $facet: {
          data: [{ $sort: sortStage }, { $skip: skip }, { $limit: limitNum }],
          total: [{ $count: 'count' }],
        },
      },
    ]);

    const data = result?.data || [];
    const total = result?.total?.[0]?.count || 0;

    const thirtyAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const userIds = data.map((t) => t._id).filter(Boolean);
    const profileIds = data.map((t) => t.profile?._id).filter(Boolean);

    const [classesAgg, earningsAgg] = await Promise.all([
      Session.aggregate([
        { $match: { tutorId: { $in: profileIds }, startDateTime: { $gte: thirtyAgo } } },
        { $group: { _id: '$tutorId', count: { $sum: 1 } } },
      ]),
      Transaction.aggregate([
        { $match: { userId: { $in: userIds }, type: 'credit', createdAt: { $gte: thirtyAgo } } },
        { $group: { _id: '$userId', total: { $sum: '$amount' } } },
      ]),
    ]);

    const classesMap = new Map(classesAgg.map((g) => [String(g._id), g.count]));
    const earningsMap = new Map(earningsAgg.map((g) => [String(g._id), g.total]));

    const rows = data.map((t) => ({
      id: t._id,
      name: t.profile?.name || 'Unknown Tutor',
      email: t.profile?.email || t.email || '',
      phone: t.profile?.altPhone || t.profile?.phone || t.phone || '',
      profilePhoto: t.profile?.photoUrl || null,
      profileComplete: !!t.isProfileComplete,
      kyc: t.profile?.kycStatus || 'pending',
      payoutDetailsStatus: t.profile?.payoutDetailsStatus || (hasPayoutDetails(t.profile) ? 'submitted' : 'pending'),
      kycDocumentsStatus: t.profile?.kycDocumentsStatus || (hasKycDocuments(t.profile) ? 'submitted' : 'pending'),
      kycRejectionReason: t.profile?.kycRejectionReason || '',
      upiId: t.profile?.upiId || '',
      accountHolderName: t.profile?.accountHolderName || '',
      bankAccountNumber: t.profile?.bankAccountNumber || '',
      ifsc: t.profile?.ifsc || '',
      aadhaarUrls: t.profile?.aadhaarUrls || [],
      panUrl: t.profile?.panUrl || null,
      rating: t.profile?.rating || 0,
      classes30d: classesMap.get(String(t.profile?._id)) || 0,
      earnings30d: earningsMap.get(String(t._id)) || 0,
      status: t.status || 'active',
      joinedAt: t.createdAt,
    }));

    res.status(200).json({
      success: true,
      data: rows,
      pagination: {
        total,
        page: pageNum,
        limit: limitNum,
        pages: Math.ceil(total / limitNum),
      },
    });
  } catch (err) {
    console.error('Get tutors error:', err);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: err.message,
    });
  }
};

// ✅ Approve / Reject KYC
exports.updateKycStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { kyc, reason = '' } = req.body; // 'approved' | 'rejected' | 'pending'

    if (!KYC_STATUSES.includes(kyc)) {
      return res.status(400).json({ success: false, message: 'Invalid KYC status' });
    }

    const tutorProfile = await TutorProfile.findOne({ userId: id });
    if (!tutorProfile) {
      return res.status(404).json({ success: false, message: 'Tutor profile not found' });
    }

    if (kyc === 'approved' && (!hasPayoutDetails(tutorProfile) || !hasKycDocuments(tutorProfile))) {
      return res.status(400).json({
        success: false,
        message: 'UPI, bank details, Aadhaar, and PAN are required before approval',
      });
    }

    tutorProfile.isVerified = kyc === 'approved';
    tutorProfile.kycStatus = kyc;
    tutorProfile.payoutDetailsStatus = kyc;
    tutorProfile.kycDocumentsStatus = kyc;
    tutorProfile.kycRejectionReason = kyc === 'rejected' ? String(reason || '').trim() : '';
    await tutorProfile.save();

    res.status(200).json({
      success: true,
      message: `KYC ${kyc} successfully`,
      profile: tutorProfile,
    });
  } catch (err) {
    console.error('KYC update error:', err);
    res.status(500).json({ success: false, message: 'Server error', error: err.message });
  }
};

// ✅ Activate / Suspend tutor
exports.updateTutorStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body; // 'active' | 'suspended'

    const user = await User.findByIdAndUpdate(id, { status }, { new: true });
    if (!user) return res.status(404).json({ success: false, message: 'Tutor not found' });

    res.status(200).json({
      success: true,
      message: `Tutor ${status === 'active' ? 'activated' : 'suspended'} successfully`,
      user,
    });
  } catch (err) {
    console.error('Tutor status error:', err);
    res.status(500).json({ success: false, message: 'Server error', error: err.message });
  }
};

// バ. Tutor journey (aggregated lifecycle view)
exports.getTutorJourney = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: 'Invalid tutor id' });
    }
    
    const tutorUser = await User.findById(id).select('phone role status createdAt').lean();
    if (!tutorUser || tutorUser.role !== 'tutor') {
      return res.status(404).json({ success: false, message: 'Tutor not found' });
    }

    const tutorProfile = await TutorProfile.findOne({ userId: id }).select('name email rating').lean();
    const tutorProfileId = tutorProfile?._id || null;
    const tutorObjId = new mongoose.Types.ObjectId(id);
    const section = String(req.query.section || '').toLowerCase();
    const defaultRecentLimit = 6;
    const limitParam = String(req.query.limit || '').toLowerCase();
    const parsedLimit = limitParam === 'all'
      ? null
      : Math.max(1, Number(limitParam) || defaultRecentLimit);
    const getLimitFor = (name) => {
      if (section && section !== name) return defaultRecentLimit;
      return parsedLimit === null ? null : parsedLimit;
    };

    const buildUserPhoneMap = async (userIds) => {
      if (!userIds.length) return new Map();
      const users = await User.find({ _id: { $in: userIds } }).select('phone').lean();
      return new Map(users.map((u) => [String(u._id), u.phone || '']));
    };

    const buildStudentProfileMapByUserId = async (userIds) => {
      if (!userIds.length) return new Map();
      const profiles = await StudentProfile.find({ userId: { $in: userIds } })
        .select('userId name email photoUrl altPhone')
        .lean();
      return new Map(profiles.map((p) => [String(p.userId), p]));
    };

    const buildStudentProfileMapById = async (profileIds) => {
      if (!profileIds.length) return new Map();
      const profiles = await StudentProfile.find({ _id: { $in: profileIds } })
        .select('userId name email photoUrl altPhone')
        .lean();
      return new Map(profiles.map((p) => [String(p._id), p]));
    };

    const formatStudentFromProfile = (profile, phoneMap) => {
      if (!profile) return null;
      return {
        id: profile._id,
        userId: profile.userId,
        name: profile.name || 'Unknown Student',
        email: profile.email || '',
        phone: phoneMap.get(String(profile.userId)) || '',
        photoUrl: profile.photoUrl || null,
        altPhone: profile.altPhone || '',
      };
    };

    // ----- Demo bookings -----
    const demoMatch = { tutorId: tutorObjId, type: 'demo' };
    const demoAgg = await Booking.aggregate([
      { $match: demoMatch },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
          conversions: {
            $sum: {
              $cond: [{ $ifNull: ['$regularClassId', false] }, 1, 0],
            },
          },
        },
      },
    ]);

    const demoStats = { total: 0, pending: 0, confirmed: 0, cancelled: 0, completed: 0, converted: 0 };
    demoAgg.forEach((g) => {
      demoStats.total += g.count || 0;
      demoStats.converted += g.conversions || 0;
      if (g._id && demoStats[g._id] !== undefined) {
        demoStats[g._id] = g.count || 0;
      }
    });
    const demoLimit = getLimitFor('demos');
    let demoQuery = Booking.find(demoMatch)
      .sort({ createdAt: -1 })
      .select('subject status preferredDate preferredTime regularClassId createdAt studentId note demoFeedback');
    if (demoLimit) demoQuery = demoQuery.limit(demoLimit);
    const latestDemos = await demoQuery.lean();

    const demoUserIds = latestDemos.map((d) => d.studentId).filter(Boolean);
    const demoPhoneMap = await buildUserPhoneMap(demoUserIds);
    const demoProfileMap = await buildStudentProfileMapByUserId(demoUserIds);
    const demosWithStudents = latestDemos.map((d) => {
      const profile = demoProfileMap.get(String(d.studentId));
      return {
        ...d,
        student: profile
          ? formatStudentFromProfile(profile, demoPhoneMap)
          : { id: d.studentId, name: 'Unknown Student', phone: demoPhoneMap.get(String(d.studentId)) || '' },
      };
    });

    // ----- Sessions (1:1 and group) -----
    const sessionStats = {
      total: 0,
      scheduled: 0,
      completed: 0,
      cancelled: 0,
      group: { total: 0, scheduled: 0, completed: 0, cancelled: 0 },
    };
    let latestSessions = [];
    if (tutorProfileId) {
      const sessionAgg = await Session.aggregate([
        { $match: { tutorId: tutorProfileId } },
        {
          $group: {
            _id: '$status',
            count: { $sum: 1 },
            groupCount: {
              $sum: {
                $cond: [{ $ifNull: ['$groupBatchId', false] }, 1, 0],
              },
            },
          },
        },
      ]);
      sessionAgg.forEach((g) => {
        const count = g.count || 0;
        sessionStats.total += count;
        if (g._id && sessionStats[g._id] !== undefined) {
          sessionStats[g._id] = count;
        }
        const groupCount = g.groupCount || 0;
        sessionStats.group.total += groupCount;
        if (g._id && sessionStats.group[g._id] !== undefined) {
          sessionStats.group[g._id] = groupCount;
        }
      });

      const sessionLimit = getLimitFor('sessions');
      let oneToOneLimit = sessionLimit === null ? null : Math.max(1, Math.ceil((sessionLimit || 6) / 2));
      let batchLimit =
        sessionLimit === null
          ? null
          : Math.max(1, (sessionLimit || 6) - oneToOneLimit);

      const oneToOneQuery = Session.find({
        tutorId: tutorProfileId,
        groupBatchId: { $in: [null, undefined] },
      })
        .sort({ startDateTime: -1 })
        .select('status startDateTime groupBatchId regularClassId createdAt studentId');
      if (oneToOneLimit) oneToOneQuery.limit(oneToOneLimit);
      const batchQuery = Session.find({
        tutorId: tutorProfileId,
        groupBatchId: { $ne: null },
      })
        .sort({ startDateTime: -1 })
        .select('status startDateTime groupBatchId regularClassId createdAt studentId');
      if (batchLimit) batchQuery.limit(batchLimit);

      const [oneToOneSessions, batchSessions] = await Promise.all([
        oneToOneQuery.lean(),
        batchQuery.lean(),
      ]);
      latestSessions = [...oneToOneSessions, ...batchSessions];
    }

    // ----- Regular classes -----
    const classSummary = { total: 0, active: 0, paused: 0, ended: 0 };
    if (tutorProfileId) {
      const classAgg = await RegularClass.aggregate([
        { $match: { tutorId: tutorProfileId } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]);
      classAgg.forEach((g) => {
        classSummary.total += g.count || 0;
        if (g._id && classSummary[g._id] !== undefined) {
          classSummary[g._id] = g.count || 0;
        }
      });
    }

    // ----- Group batches -----
    const batchSummary = { total: 0, active: 0, cancelled: 0 };
    let recentBatches = [];
    if (tutorProfileId) {
      batchSummary.total = await GroupBatch.countDocuments({ tutorId: tutorProfileId });
      batchSummary.active = await GroupBatch.countDocuments({ tutorId: tutorProfileId, status: 'active' });
      batchSummary.cancelled = await GroupBatch.countDocuments({ tutorId: tutorProfileId, status: 'cancelled' });

      const batchLimit = getLimitFor('batches');
      let batchQuery = GroupBatch.find({ tutorId: tutorProfileId })
        .sort({ createdAt: -1 })
        .select('subject batchType status batchStartDate batchEndDate seatCap enrolled createdAt');
      if (batchLimit) batchQuery = batchQuery.limit(batchLimit);
      recentBatches = await batchQuery.lean();
    }

    // ----- Notes -----
    const noteSummary = { total: 0 };
    if (tutorProfileId) {
      noteSummary.total = await Note.countDocuments({
        tutorId: { $in: [tutorProfileId, tutorObjId] },
      });
    }

    // ----- Payments -----
    const paymentSummary = { revenue: 0, payouts: 0, refunds: 0 };
    let recentPayments = [];
    if (tutorProfileId) {
      const paymentAgg = await Payment.aggregate([
        { $match: { tutorId: tutorProfileId } },
        {
          $group: {
            _id: '$type',
            paidAmount: {
              $sum: {
                $cond: [{ $in: ['$status', ['paid', 'settled']] }, '$amount', 0],
              },
            },
            refundTotal: { $sum: '$refundTotal' },
          },
        },
      ]);

      paymentAgg.forEach((g) => {
        if (['subscription', 'group', 'note'].includes(g._id)) {
          paymentSummary.revenue += Number(g.paidAmount || 0);
          paymentSummary.refunds += Number(g.refundTotal || 0);
        }
        if (g._id === 'payout') {
          paymentSummary.payouts += Number(g.paidAmount || 0);
        }
      });

      const paymentLimit = getLimitFor('payments');
      let paymentQuery = Payment.find({ tutorId: tutorProfileId })
        .sort({ createdAt: -1 })
        .select('type status amount currency refundTotal createdAt studentId regularClassId groupBatchId noteId notes');
      if (paymentLimit) paymentQuery = paymentQuery.limit(paymentLimit);
      recentPayments = await paymentQuery.lean();
    }

    // ----- Notes (details) -----
    let recentNotes = [];
    if (tutorProfileId) {
      const noteLimit = getLimitFor('notes');
      let noteQuery = Note.find({ tutorId: tutorProfileId })
        .sort({ createdAt: -1 })
        .select('title subject classLevel board price createdAt');
      if (noteLimit) noteQuery = noteQuery.limit(noteLimit);
      recentNotes = await noteQuery.lean();
    }

    // ----- Student lookups -----
    const sessionStudentIds = latestSessions.map((s) => s.studentId).filter(Boolean);
    const sessionStudentMap = await buildStudentProfileMapById(sessionStudentIds);
    const sessionUserIds = Array.from(sessionStudentMap.values())
      .map((p) => p.userId)
      .filter(Boolean);
    const sessionPhoneMap = await buildUserPhoneMap(sessionUserIds);

    const batchIdsFromSessions = latestSessions.map((s) => s.groupBatchId).filter(Boolean);
    const recentBatchIds = recentBatches.map((b) => b._id).filter(Boolean);
    const allBatchIds = Array.from(new Set([...batchIdsFromSessions, ...recentBatchIds].map(String)));
    const batchDetails = allBatchIds.length
      ? await GroupBatch.find({ _id: { $in: allBatchIds } })
          .select('subject batchType status batchStartDate batchEndDate seatCap enrolled')
          .lean()
      : [];
    const batchMap = new Map(batchDetails.map((b) => [String(b._id), b]));
    const batchStudentIds = batchDetails.flatMap((b) => b.enrolled || []);
    const batchStudentMap = await buildStudentProfileMapById(batchStudentIds);
    const batchUserIds = Array.from(batchStudentMap.values())
      .map((p) => p.userId)
      .filter(Boolean);
    const batchPhoneMap = await buildUserPhoneMap(batchUserIds);

    const enrichBatchStudents = (batch) => {
      const students = (batch?.enrolled || [])
        .map((id) => {
          const profile = batchStudentMap.get(String(id));
          return formatStudentFromProfile(profile, batchPhoneMap);
        })
        .filter(Boolean);
      return {
        id: batch?._id || null,
        subject: batch?.subject || '',
        batchType: batch?.batchType || '',
        status: batch?.status || '',
        batchStartDate: batch?.batchStartDate,
        batchEndDate: batch?.batchEndDate,
        seatCap: batch?.seatCap || 0,
        enrolledCount: students.length,
        students,
      };
    };

    const sessionsWithStudents = latestSessions.map((s) => {
      const studentProfile = s.studentId ? sessionStudentMap.get(String(s.studentId)) : null;
      const student = formatStudentFromProfile(studentProfile, sessionPhoneMap);
      const batch = s.groupBatchId ? batchMap.get(String(s.groupBatchId)) : null;
      return {
        ...s,
        student,
        batch: batch ? enrichBatchStudents(batch) : null,
      };
    });

    const batchesWithStudents = recentBatches.map((b) => {
      const batch = batchMap.get(String(b._id)) || b;
      const info = enrichBatchStudents(batch);
      return {
        ...b,
        enrolledCount: info.enrolledCount,
        students: info.students,
      };
    });

    const paymentStudentIds = recentPayments.map((p) => p.studentId).filter(Boolean);
    const paymentStudentMap = await buildStudentProfileMapById(paymentStudentIds);
    const paymentUserIds = Array.from(paymentStudentMap.values())
      .map((p) => p.userId)
      .filter(Boolean);
    const paymentPhoneMap = await buildUserPhoneMap(paymentUserIds);

    const paymentClassIds = recentPayments.map((p) => p.regularClassId).filter(Boolean);
    const paymentBatchIds = recentPayments.map((p) => p.groupBatchId).filter(Boolean);
    const paymentNoteIds = recentPayments.map((p) => p.noteId).filter(Boolean);

    const [paymentClasses, paymentBatches, paymentNotes] = await Promise.all([
      paymentClassIds.length
        ? RegularClass.find({ _id: { $in: paymentClassIds } }).select('subject').lean()
        : [],
      paymentBatchIds.length
        ? GroupBatch.find({ _id: { $in: paymentBatchIds } }).select('subject').lean()
        : [],
      paymentNoteIds.length ? Note.find({ _id: { $in: paymentNoteIds } }).select('title').lean() : [],
    ]);

    const classMap = new Map(paymentClasses.map((c) => [String(c._id), c]));
    const paymentBatchMap = new Map(paymentBatches.map((b) => [String(b._id), b]));
    const noteMap = new Map(paymentNotes.map((n) => [String(n._id), n]));

    const paymentsWithStudents = recentPayments.map((p) => {
      const studentProfile = p.studentId ? paymentStudentMap.get(String(p.studentId)) : null;
      const student = formatStudentFromProfile(studentProfile, paymentPhoneMap);
      const note = p.noteId ? noteMap.get(String(p.noteId)) : null;
      const batch = p.groupBatchId ? paymentBatchMap.get(String(p.groupBatchId)) : null;
      const klass = p.regularClassId ? classMap.get(String(p.regularClassId)) : null;
      const reason =
        (note && `Note: ${note.title}`) ||
        (batch && `Batch: ${batch.subject}`) ||
        (klass && `Class: ${klass.subject}`) ||
        p.notes ||
        '';
      return {
        ...p,
        student,
        reason,
      };
    });

    return res.status(200).json({
      success: true,
      data: {
        tutor: {
          id: tutorUser._id,
          profileId: tutorProfileId,
          name: tutorProfile?.name || 'Unknown Tutor',
          email: tutorProfile?.email || '',
          phone: tutorUser.phone || '',
          rating: tutorProfile?.rating || 0,
          status: tutorUser.status || 'active',
          joinedAt: tutorUser.createdAt,
        },
        demos: demoStats,
        sessions: sessionStats,
        regularClasses: classSummary,
        batches: batchSummary,
        notes: noteSummary,
        payments: paymentSummary,
        recent: {
          demos: demosWithStudents,
          sessions: sessionsWithStudents,
          batches: batchesWithStudents,
          payments: paymentsWithStudents,
          notes: recentNotes,
        },
      },
    });
  } catch (err) {
    console.error('Tutor journey error:', err);
    res.status(500).json({ success: false, message: 'Server error', error: err.message });
  }
};
