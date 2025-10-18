const User = require('../models/User');
const StudentProfile = require('../models/StudentProfile');
const TutorProfile = require('../models/TutorProfile');

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

module.exports = {
  getAllUsers,
  getUserById,
  updateUserStatus,
  verifyTutor,
  updateUserStatus
};