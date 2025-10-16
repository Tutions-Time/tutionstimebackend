const User = require('../models/User');
const StudentProfile = require('../models/StudentProfile');
const TutorProfile = require('../models/TutorProfile');

// Get user profile
const getUserProfile = async (req, res) => {
  try {
    const userId = req.user.id;
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
        user: {
          id: user._id,
          phone: user.phone,
          role: user.role,
          isProfileComplete: user.isProfileComplete,
          status: user.status,
          lastLogin: user.lastLogin
        },
        profile: profile || null
      }
    });
  } catch (error) {
    console.error('Get Profile Error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};

// Create/Update student profile
const updateStudentProfile = async (req, res) => {
  try {
    const userId = req.user.id;
    const user = await User.findById(userId);
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }
    
    if (user.role !== 'student') {
      return res.status(403).json({
        success: false,
        message: 'Only students can update student profiles'
      });
    }
    
    const { name, email, gender, classLevel, subjects, goals, pincode } = req.body;
    
    // Validate required fields
    if (!name || !email || !gender || !classLevel) {
      return res.status(400).json({
        success: false,
        message: 'Name, email, gender, and class level are required'
      });
    }

    // Handle photo upload
    let photoUrl = null;
    if (req.files && req.files.photo) {
      photoUrl = req.files.photo[0].path;
    }
    
    // Find existing profile or create new one
    let profile = await StudentProfile.findOne({ userId });
    
    const profileData = {
      userId,
      name,
      email,
      gender,
      classLevel,
      subjects: subjects ? JSON.parse(subjects) : [],
      goals: goals || '',
      pincode: pincode || '',
      ...(photoUrl && { photoUrl })
    };

    if (profile) {
      // Update existing profile
      profile = await StudentProfile.findOneAndUpdate(
        { userId },
        profileData,
        { new: true }
      );
    } else {
      // Create new profile
      profile = await StudentProfile.create(profileData);
    }
    
    // Update user's profile completion status
    if (!user.isProfileComplete) {
      user.isProfileComplete = true;
      await user.save();
    }
    
    res.status(200).json({
      success: true,
      message: 'Student profile updated successfully',
      data: profile
    });
  } catch (error) {
    console.error('Update Student Profile Error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};

// Create/Update tutor profile
const updateTutorProfile = async (req, res) => {
  try {
    const userId = req.user.id;
    const user = await User.findById(userId);
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }
    
    if (user.role !== 'tutor') {
      return res.status(403).json({
        success: false,
        message: 'Only tutors can update tutor profiles'
      });
    }
    
    const { 
      name, email, gender, qualification, experience, subjects,
      classLevels, teachingMode, hourlyRate, monthlyRate,
      availableDays, bio, achievements, demoVideoUrl, pincode
    } = req.body;
    
    // Validate required fields
    if (!name || !email || !gender || !qualification || !subjects || !hourlyRate || !bio) {
      return res.status(400).json({
        success: false,
        message: 'Name, email, gender, qualification, subjects, hourlyRate, and bio are required'
      });
    }

    // Handle file uploads
    let photoUrl = null;
    let certificateUrl = null;
    let demoVideoFileUrl = null;

    if (req.files) {
      if (req.files.photo) {
        photoUrl = req.files.photo[0].path;
      }
      if (req.files.certificate) {
        certificateUrl = req.files.certificate[0].path;
      }
      if (req.files.demoVideo) {
        demoVideoFileUrl = req.files.demoVideo[0].path;
      }
    }
    
    // Create profile data object
    const profileData = {
      userId,
      name,
      email,
      gender,
      qualification,
      experience: experience || '',
      subjects: subjects ? JSON.parse(subjects) : [],
      classLevels: classLevels ? JSON.parse(classLevels) : [],
      teachingMode: teachingMode || 'both',
      hourlyRate: parseFloat(hourlyRate) || 0,
      monthlyRate: parseFloat(monthlyRate) || 0,
      availableDays: availableDays ? JSON.parse(availableDays) : [],
      bio: bio || '',
      achievements: achievements || '',
      pincode: pincode || '',
      ...(photoUrl && { photoUrl }),
      ...(certificateUrl && { certificateUrl }),
      ...(demoVideoFileUrl && { demoVideoUrl: demoVideoFileUrl }),
      ...(demoVideoUrl && !demoVideoFileUrl && { demoVideoUrl })
    };

    // Find existing profile or create new one
    let profile = await TutorProfile.findOne({ userId });
    
    if (profile) {
      // Update existing profile
      profile = await TutorProfile.findOneAndUpdate(
        { userId },
        profileData,
        { new: true }
      );
    } else {
      // Create new profile
      profile = await TutorProfile.create(profileData);
    }
    
    // Update user's profile completion status
    if (!user.isProfileComplete) {
      user.isProfileComplete = true;
      await user.save();
    }
    
    res.status(200).json({
      success: true,
      message: 'Tutor profile updated successfully',
      data: profile
    });
  } catch (error) {
    console.error('Update Tutor Profile Error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};

module.exports = {
  getUserProfile,
  updateStudentProfile,
  updateTutorProfile
};