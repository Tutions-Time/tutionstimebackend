const User = require('../models/User');
const StudentProfile = require('../models/StudentProfile');
const TutorProfile = require('../models/TutorProfile');
const Session = require('../models/Session');
const Payment = require('../models/Payment');
const AdminWallet = require('../models/AdminWallet');

// Get all users with pagination
const getAllUsers = async (req, res) => {
  try {
    // Fetch all users (no passwords or refresh tokens)
    const users = await User.find().select('-password -refreshToken').lean();

    // Fetch student and tutor profiles
    const studentProfiles = await StudentProfile.find().lean();
    const tutorProfiles = await TutorProfile.find().lean();

    // Create maps for quick lookup
    const studentMap = new Map(studentProfiles.map((p) => [p.userId.toString(), p]));
    const tutorMap = new Map(tutorProfiles.map((p) => [p.userId.toString(), p]));

    // Merge user data with corresponding profile data
    const mergedUsers = users.map((u) => {
      let profile = null;
      let name = null;
      let email = null;
      let photoUrl = null;

      if (u.role === 'student' && studentMap.has(u._id.toString())) {
        profile = studentMap.get(u._id.toString());
        name = profile.name || null;
        email = profile.email || null;
        photoUrl = profile.photoUrl || null;
      } else if (u.role === 'tutor' && tutorMap.has(u._id.toString())) {
        profile = tutorMap.get(u._id.toString());
        name = profile.name || null;
        email = profile.email || null;
        photoUrl = profile.photoUrl || null;
      }

      return {
        _id: u._id,
        name,
        email,
        phone: u.phone,
        role: u.role,
        status: u.status,
        isProfileComplete: u.isProfileComplete,
        lastLogin: u.lastLogin,
        createdAt: u.createdAt,
        profilePhoto: photoUrl,
      };
    });

    res.status(200).json({
      success: true,
      data: {
        users: mergedUsers,
        pagination: {
          total: mergedUsers.length,
          page: 1,
          limit: mergedUsers.length,
          pages: 1,
        },
      },
    });
  } catch (error) {
    console.error('Get All Users Error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message,
    });
  }
};

// Get user details by ID
const getUserById = async (req, res) => {
  try {
    const { userId } = req.params;
    
    const user = await User.findById(userId).select('-refreshToken');
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }
    
    let profile;
    if (user.role === 'student') {
      profile = await StudentProfile.findOne({ userId });
    } else if (user.role === 'tutor') {
      profile = await TutorProfile.findOne({ userId });
    }
    
    res.status(200).json({
      success: true,
      data: {
        user,
        profile: profile || null
      }
    });
  } catch (error) {
    console.error('Get User By ID Error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};



// Verify tutor
const verifyTutor = async (req, res) => {
  try {
    const { tutorId } = req.params;
    const { isVerified } = req.body;
    
    if (isVerified === undefined) {
      return res.status(400).json({
        success: false,
        message: 'isVerified field is required'
      });
    }
    
    const tutorProfile = await TutorProfile.findOne({ userId: tutorId });
    
    if (!tutorProfile) {
      return res.status(404).json({
        success: false,
        message: 'Tutor profile not found'
      });
    }
    
    tutorProfile.isVerified = isVerified;
    await tutorProfile.save();
    
    res.status(200).json({
      success: true,
      message: `Tutor ${isVerified ? 'verified' : 'unverified'} successfully`,
      data: {
        tutorId,
        isVerified
      }
    });
  } catch (error) {
    console.error('Verify Tutor Error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};

const updateUserStatus = async (req, res) => {
  try {
    const userId = req.params.id;
    const { status } = req.body;

    if (!['active', 'inactive'].includes(status)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid status value. Use active or inactive.',
      });
    }

    const user = await User.findByIdAndUpdate(
      userId,
      { status },
      { new: true }
    ).select('-password -refreshToken');

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
      });
    }

    res.status(200).json({
      success: true,
      message: `User ${status === 'active' ? 'activated' : 'deactivated'} successfully`,
      user,
    });
  } catch (error) {
    console.error('Update User Status Error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message,
    });
  }
};

const getDashboardStats = async (req, res) => {
  try {
    const totalUsers = await User.countDocuments();
    const students = await User.countDocuments({ role: 'student' });
    const tutors = await User.countDocuments({ role: 'tutor' });
    const admins = await User.countDocuments({ role: 'admin' });

    const activeUsers = await User.countDocuments({ status: 'active' });
    const inactiveUsers = await User.countDocuments({ status: 'inactive' });

    const kycApproved = await TutorProfile.countDocuments({ kycStatus: 'approved' });
    const kycPending = await TutorProfile.countDocuments({ kycStatus: 'pending' });
    const kycRejected = await TutorProfile.countDocuments({ kycStatus: 'rejected' });

    const sessionsScheduled = await Session.countDocuments({ status: 'scheduled' });
    const sessionsCompleted = await Session.countDocuments({ status: 'completed' });
    const upcoming7d = await Session.countDocuments({ startDateTime: { $gte: new Date(), $lte: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) } });

    const subsPaidAgg = await Payment.aggregate([
      { $match: { type: 'subscription', status: 'paid' } },
      { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }
    ]);
    const notesPaidAgg = await Payment.aggregate([
      { $match: { type: 'note', status: 'paid' } },
      { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }
    ]);
    const payoutsAgg = await Payment.aggregate([
      { $match: { type: 'payout' } },
      { $group: { _id: null, created: { $sum: { $cond: [{ $eq: ['$status', 'created'] }, 1, 0] } }, settled: { $sum: { $cond: [{ $eq: ['$status', 'settled'] }, 1, 0] } }, commissionTotal: { $sum: '$commissionAmount' }, amountTotal: { $sum: '$amount' } } }
    ]);

    const adminWallet = await AdminWallet.findOne();

    const stats = {
      users: { total: totalUsers, students, tutors, admins, active: activeUsers, inactive: inactiveUsers },
      kyc: { approved: kycApproved, pending: kycPending, rejected: kycRejected },
      sessions: { scheduled: sessionsScheduled, completed: sessionsCompleted, upcoming7d },
      payments: {
        subscriptions: { totalAmount: subsPaidAgg[0]?.total || 0, count: subsPaidAgg[0]?.count || 0 },
        notes: { totalAmount: notesPaidAgg[0]?.total || 0, count: notesPaidAgg[0]?.count || 0 },
        payouts: { created: payoutsAgg[0]?.created || 0, settled: payoutsAgg[0]?.settled || 0, commissionTotal: payoutsAgg[0]?.commissionTotal || 0, amountTotal: payoutsAgg[0]?.amountTotal || 0 }
      },
      adminWallet: adminWallet ? { balance: adminWallet.balance || 0, holdAmount: adminWallet.holdAmount || 0 } : { balance: 0, holdAmount: 0 }
    };

    res.status(200).json({ success: true, stats });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error', error: error.message });
  }
};

const listAdminSessions = async (req, res) => {
  try {
    const { status, from, to, page = 1, limit = 50 } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (from || to) {
      filter.startDateTime = {};
      if (from) filter.startDateTime.$gte = new Date(from);
      if (to) filter.startDateTime.$lte = new Date(to);
    }
    const skip = Math.max(0, (Number(page) - 1) * Number(limit));
    const sessions = await Session.find(filter)
      .sort({ startDateTime: -1 })
      .skip(skip)
      .limit(Number(limit))
      .populate({ path: 'regularClassId', select: 'subject planType studentId tutorId' })
      .lean();

    res.status(200).json({ success: true, data: sessions });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error', error: error.message });
  }
};

module.exports = {
  getAllUsers,
  getUserById,
  updateUserStatus,
  verifyTutor,
  updateUserStatus,
  getDashboardStats
  ,listAdminSessions
};
