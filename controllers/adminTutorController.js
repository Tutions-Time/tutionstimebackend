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
      email: t.profile?.email || '',
      phone: t.phone || '',
      profilePhoto: t.profile?.photoUrl || null,
      kyc: t.profile?.kycStatus || 'pending',
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
    const { kyc } = req.body; // 'approved' | 'rejected' | 'pending'

    const update = {
      isVerified: kyc === 'approved',
      kycStatus: kyc,
    };
    const tutorProfile = await TutorProfile.findOneAndUpdate(
      { userId: id },
      update,
      { new: true }
    );

    if (!tutorProfile) {
      return res.status(404).json({ success: false, message: 'Tutor profile not found' });
    }

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
    const latestDemos = await Booking.find(demoMatch)
      .sort({ createdAt: -1 })
      .limit(5)
      .select('subject status preferredDate preferredTime regularClassId createdAt')
      .lean();

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

      latestSessions = await Session.find({ tutorId: tutorProfileId })
        .sort({ startDateTime: -1 })
        .limit(5)
        .select('status startDateTime groupBatchId regularClassId createdAt')
        .lean();
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

      recentBatches = await GroupBatch.find({ tutorId: tutorProfileId })
        .sort({ createdAt: -1 })
        .limit(5)
        .select('subject batchType status batchStartDate batchEndDate seatCap enrolled createdAt')
        .lean();
    }

    // ----- Notes -----
    const noteSummary = { total: 0 };
    if (tutorProfileId) {
      noteSummary.total = await Note.countDocuments({ tutorId: tutorProfileId });
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

      recentPayments = await Payment.find({ tutorId: tutorProfileId })
        .sort({ createdAt: -1 })
        .limit(5)
        .select('type status amount currency refundTotal createdAt')
        .lean();
    }

    return res.status(200).json({
      success: true,
      data: {
        tutor: {
          id: tutorUser._id,
          profileId: tutorProfileId,
          name: tutorProfile?.name || 'Unknown Tutor',
          email: tutorProfile?.email || '',
          phone: tutorUser.phone || '',
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
          demos: latestDemos,
          sessions: latestSessions,
          batches: recentBatches,
          payments: recentPayments,
        },
      },
    });
  } catch (err) {
    console.error('Tutor journey error:', err);
    res.status(500).json({ success: false, message: 'Server error', error: err.message });
  }
};
