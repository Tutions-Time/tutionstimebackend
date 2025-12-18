const mongoose = require('mongoose');
const User = require('../models/User');
const TutorProfile = require('../models/TutorProfile');
const Booking = require('../models/Booking');
const Session = require('../models/Session');
const Payment = require('../models/Payment');
const GroupBatch = require('../models/GroupBatch');
const RegularClass = require('../models/RegularClass');
const Note = require('../models/Note');

// ✅ Get all tutors with joined KYC and performance info
exports.getAllTutors = async (req, res) => {
  try {
    const tutors = await User.find({ role: 'tutor' })
      .select('-password -refreshToken')
      .lean();

    const tutorProfiles = await TutorProfile.find().lean();
    const profileMap = new Map(tutorProfiles.map(p => [p.userId.toString(), p]));
    const thirtyAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const Session = require('../models/Session');
    const Transaction = require('../models/Transaction');
    const result = [];
    for (const tutor of tutors) {
      const profile = profileMap.get(tutor._id.toString());
      let classes30d = 0;
      let earnings30d = 0;
      if (profile?._id) {
        classes30d = await Session.countDocuments({ tutorId: profile._id, startDateTime: { $gte: thirtyAgo } });
      }
      const credits = await Transaction.find({ userId: tutor._id, type: 'credit', createdAt: { $gte: thirtyAgo } }).select('amount').lean();
      earnings30d = credits.reduce((sum, t) => sum + Number(t.amount || 0), 0);
      result.push({
        id: tutor._id,
        name: profile?.name || 'Unknown Tutor',
        email: profile?.email || '',
        phone: tutor.phone || '',
        kyc: profile?.kycStatus || 'pending',
        aadhaarUrls: profile?.aadhaarUrls || [],
        panUrl: profile?.panUrl || null,
        rating: profile?.rating || 0,
        classes30d,
        earnings30d,
        status: tutor.status || 'active',
        joinedAt: tutor.createdAt,
      });
    }

    res.status(200).json({
      success: true,
      data: result,
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
