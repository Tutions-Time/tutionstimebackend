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

    const result = tutors.map(tutor => {
      const profile = profileMap.get(tutor._id.toString());
      return {
        id: tutor._id,
        name: profile?.name || 'Unknown Tutor',
        email: profile?.email || '',
        phone: tutor.phone || '',
        kyc: profile?.isVerified
          ? 'approved'
          : profile
          ? 'pending'
          : 'pending',
        rating: profile?.averageRating || 0,
        classes30d: profile?.classes30d || 0,
        earnings30d: profile?.earnings30d || 0,
        status: tutor.status || 'active',
        joinedAt: tutor.createdAt,
      };
    });

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

    const tutorProfile = await TutorProfile.findOneAndUpdate(
      { userId: id },
      { isVerified: kyc === 'approved' },
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
