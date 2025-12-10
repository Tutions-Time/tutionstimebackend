const User = require('../models/User');
const TutorProfile = require('../models/TutorProfile');

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
