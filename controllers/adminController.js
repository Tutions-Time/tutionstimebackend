const User = require('../models/User');
const StudentProfile = require('../models/StudentProfile');
const TutorProfile = require('../models/TutorProfile');

// Get all users with pagination
const getAllUsers = async (req, res) => {
  try {
    const { page = 1, limit = 10, role, status } = req.query;
    const skip = (page - 1) * limit;
    
    // Build query
    const query = {};
    if (role) query.role = role;
    if (status) query.status = status;
    
    // Get users with pagination
    const users = await User.find(query)
      .select('-refreshToken')
      .skip(skip)
      .limit(parseInt(limit))
      .sort({ createdAt: -1 });
    
    // Get total count
    const total = await User.countDocuments(query);
    
    res.status(200).json({
      success: true,
      data: {
        users,
        pagination: {
          total,
          page: parseInt(page),
          limit: parseInt(limit),
          pages: Math.ceil(total / limit)
        }
      }
    });
  } catch (error) {
    console.error('Get All Users Error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
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

// Update user status
const updateUserStatus = async (req, res) => {
  try {
    const { userId } = req.params;
    const { status } = req.body;
    
    if (!status || !['active', 'inactive', 'suspended'].includes(status)) {
      return res.status(400).json({
        success: false,
        message: 'Valid status is required'
      });
    }
    
    const user = await User.findById(userId);
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }
    
    user.status = status;
    await user.save();
    
    res.status(200).json({
      success: true,
      message: 'User status updated successfully',
      data: {
        id: user._id,
        status: user.status
      }
    });
  } catch (error) {
    console.error('Update User Status Error:', error);
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

module.exports = {
  getAllUsers,
  getUserById,
  updateUserStatus,
  verifyTutor
};