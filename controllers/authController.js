const User = require('../models/User');
const otpService = require('../services/otpService');
const tokenService = require('../services/tokenService');
const walletService = require("../services/payments/walletService");
const bcrypt = require('bcryptjs');
const StudentProfile = require('../models/StudentProfile');
const TutorProfile = require('../models/TutorProfile');
const {
  isStudentProfileComplete,
  isTutorProfileComplete,
} = require('../utils/profileValidation');

// Admin credentials (Move to environment variables in production)
const ADMIN_USERNAME = 'admin';
const ADMIN_PASSWORD = '$2b$10$TCUXGHzI/sxObzQLY7zRBePZqLVYpOE.6hZ/1nlVWAHy5PGxw2DP2'; // "admin123"

// Admin login
const adminLogin = async (req, res) => {
  try {
    const { username, password } = req.body;

    // Validate input
    if (!username || !password) {
      return res.status(400).json({
        success: false,
        message: 'Username and password are required'
      });
    }

    // Check username
    if (username !== ADMIN_USERNAME) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials'
      });
    }

    // Verify password
    const isValid = await bcrypt.compare(password, ADMIN_PASSWORD);
    if (!isValid) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials'
      });
    }

    // Generate tokens
    const adminUser = {
      id: 'admin',
      role: 'admin',
      isProfileComplete: true
    };

    const accessToken = tokenService.generateAccessToken(adminUser.id, adminUser.role);
    const refreshToken = tokenService.generateRefreshToken(adminUser.id);

    res.status(200).json({
      success: true,
      message: 'Login successful',
      user: adminUser,
      tokens: {
        accessToken,
        refreshToken,
        expiresIn: 3600 // 1 hour in seconds
      }
    });
  } catch (error) {
    console.error('Admin Login Error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};

// Send OTP for login or signup
const sendOTP = async (req, res) => {
  try {
    const { phone, purpose } = req.body;

    if (!phone || !purpose || !['login', 'signup'].includes(purpose)) {
      return res.status(400).json({
        success: false,
        message: 'Phone number and valid purpose are required'
      });
    }

    // Generate and store OTP
    const { otp, requestId, expiresAt } = otpService.storeOTP(phone, purpose);

    // Send OTP via SMS (mock in development)
    const sent = await otpService.sendOTP(phone, otp);

    if (!sent) {
      console.error('Send OTP Error: failed to send SMS', {
        phone,
        purpose,
        requestId,
        time: new Date().toISOString(),
      });
      return res.status(500).json({
        success: false,
        message: 'Failed to send OTP SMS. Please try again.',
      });
    }

    res.status(200).json({
      success: true,
      message: 'OTP sent successfully',
      requestId,
      expiresIn: Math.floor((expiresAt - Date.now()) / 1000)
    });
  } catch (error) {
    console.error('Send OTP Error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};

// Verify OTP and authenticate user
const verifyOTP = async (req, res) => {
  try {
    const { phone, otp, requestId, role } = req.body;

    // console.log('Verify OTP Request:', {
    //   phone,
    //   otp,
    //   requestId,
    //   role,
    //   timestamp: new Date().toISOString()
    // });

    // Validate required fields
    if (!phone || !otp || !requestId) {
      console.log('Missing required fields:', { phone, otp, requestId });
      return res.status(400).json({
        success: false,
        message: 'Phone, OTP, and requestId are required'
      });
    }

    // Check if phone number is valid
    if (!/^[0-9]{10}$/.test(phone)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid phone number format'
      });
    }

    // Verify OTP
    const verification = otpService.verifyOTP(requestId, otp, phone);

    if (!verification.valid) {
      return res.status(400).json({
        success: false,
        message: verification.message
      });
    }

    let user;

    // For signup, create a new user if not exists
    if (verification.purpose === 'signup') {
      if (!role || !['student', 'tutor'].includes(role)) {
        return res.status(400).json({
          success: false,
          message: 'Valid role is required for signup'
        });
      }

      // Check if user already exists
      const existingUser = await User.findOne({ phone });

      if (existingUser) {
        return res.status(400).json({
          success: false,
          message: 'User already exists. Please login instead'
        });
      }

      // Validate phone number
      if (!phone || !/^[0-9]{10}$/.test(phone)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid phone number format. Must be 10 digits.'
        });
      }

      try {
        // Create new user
        user = await User.create({
          phone: phone.trim(),
          role,
          isProfileComplete: false,
          status: 'active'
        });
        await walletService.ensureWallet(user._id, user.role);

        // Auto-create referral code for this user
        try {
          const ReferralCode = require('../models/ReferralCode');
          const genCode = async () => {
            const base = `TT${(user.role || 'U').charAt(0).toUpperCase()}`;
            const random = Math.random().toString(36).substring(2, 8).toUpperCase();
            return `${base}${random}`;
          };
          let code = await genCode();
          // Ensure uniqueness
          for (let i = 0; i < 5; i++) {
            const exists = await ReferralCode.findOne({ code });
            if (!exists) break;
            code = await genCode();
          }
          await ReferralCode.create({
            code,
            ownerUserId: user._id,
            rewardType: 'fixed',
            rewardAmount: 0,
            maxUses: 1000000,
            allowedRoles: ['student', 'tutor'],
            status: 'active',
          });
        } catch (_) {}

        // Optional referral code capture
        if (req.body && typeof req.body.referralCode === 'string') {
          try {
            const ReferralCode = require('../models/ReferralCode');
            const rc = await ReferralCode.findOne({ code: req.body.referralCode.trim() });
          if (rc && rc.status === 'active') {
            user.referrerUserId = rc.ownerUserId;
            user.referralCodeUsed = rc.code;
            await user.save();
          }
        } catch (_) {}
      }

      try {
        if (user.role === 'student' && user.referrerUserId && !user.referralRewardGranted) {
          const ReferralSettings = require('../models/ReferralSettings');
          const ReferralCode = require('../models/ReferralCode');
          const ReferralUse = require('../models/ReferralUse');
          const { notifyUser } = require('../services/notificationService');
          const referrer = await User.findById(user.referrerUserId).select('role');
          const settings = await ReferralSettings.findOne();
          const rc = user.referralCodeUsed ? await ReferralCode.findOne({ code: user.referralCodeUsed }) : null;
          if (rc && rc.maxUses && rc.usedCount >= rc.maxUses) {
          } else {
            const defaultStudent = 100;
            const defaultTutor = 100;
            const rewardAmount = (referrer?.role === 'tutor' ? (settings?.tutorRewardAmount ?? defaultTutor) : (settings?.studentRewardAmount ?? defaultStudent));
            const refRole = referrer?.role === 'student' ? 'student' : 'tutor';
            const aw1 = await walletService.getAdminWallet();
            if ((aw1?.balance || 0) < rewardAmount) {
              await walletService.adminCredit(rewardAmount, 'Referral fund top-up', { type: 'referral' });
            }
            await walletService.adminDebit(rewardAmount, 'Referral reward', { type: 'referral' });
            await walletService.creditWallet(user.referrerUserId, refRole, rewardAmount, 'Referral reward', { type: 'referral' });
            if (!user.referralStudentRewardGranted) {
              const aw2 = await walletService.getAdminWallet();
              if ((aw2?.balance || 0) < rewardAmount) {
                await walletService.adminCredit(rewardAmount, 'Referral fund top-up', { type: 'referral' });
              }
              await walletService.adminDebit(rewardAmount, 'Referral student reward', { type: 'referral' });
              await walletService.creditWallet(user._id, 'student', rewardAmount, 'Referral student reward', { type: 'referral' });
              user.referralStudentRewardGranted = true;
            }
            const bonus = settings?.referredUserBonusAmount ?? 0;
            if (bonus > 0 && !user.referralSignupBonusGranted) {
              const aw3 = await walletService.getAdminWallet();
              if ((aw3?.balance || 0) < bonus) {
                await walletService.adminCredit(bonus, 'Referral fund top-up', { type: 'referral' });
              }
              await walletService.adminDebit(bonus, 'Referral signup bonus', { type: 'referral' });
              await walletService.creditWallet(user._id, 'student', bonus, 'Referral signup bonus', { type: 'referral' });
              user.referralSignupBonusGranted = true;
            }
            if (rc) {
              await ReferralUse.create({ referralCodeId: rc._id, referrerUserId: user.referrerUserId, referredUserId: user._id, paymentId: null, rewardGranted: true, amountGranted: rewardAmount });
              rc.usedCount = (rc.usedCount || 0) + 1;
              await rc.save();
            }
            user.referralRewardGranted = true;
            await user.save();
            if (typeof notifyUser === 'function') {
              await notifyUser(user.referrerUserId, 'Referral reward', `You earned ₹${rewardAmount} for referring a signup`, { referredUserId: user._id });
              await notifyUser(user._id, 'Referral reward', `You received ₹${rewardAmount} for using a referral`, { referrerUserId: user.referrerUserId });
              if (bonus > 0) {
                await notifyUser(user._id, 'Referral signup bonus', `You received ₹${bonus} signup bonus`, { referrerUserId: user.referrerUserId });
              }
            }
          }
        }
      } catch (_) {}

        // console.log('User created successfully:', {
        //   id: user._id,
        //   phone: user.phone,
        //   role: user.role
        // });
      } catch (error) {
        console.error('User creation error:', {
          phone: phone.trim(),
          role,
          error: error.message
        });
        throw error;
      }
    } else {
      // For login, find existing user
      user = await User.findOne({ phone });

      if (!user) {
        return res.status(404).json({
          success: false,
          message: 'User not found'
        });
      }
    }

    if (user.status === 'inactive' || user.status === 'suspended') {
      return res.status(403).json({
        success: false,
        message: 'Your account is blocked. Please contact support.'
      });
    }

    // Generate tokens
    const accessToken = tokenService.generateAccessToken(user._id, user.role);
    const refreshToken = tokenService.generateRefreshToken(user._id);

    // Save refresh token to user
    await tokenService.saveRefreshToken(user._id, refreshToken);

    res.status(200).json({
      success: true,
      message: 'OTP verified successfully',
      user: {
        id: user._id,
        phone: user.phone,
        role: user.role,
        isProfileComplete: user.isProfileComplete
      },
      tokens: {
        accessToken,
        refreshToken,
        expiresIn: 3600 // 1 hour in seconds
      }
    });
  } catch (error) {
    console.error('Verify OTP Error:', error);

    // Handle specific error types
    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        message: 'User with this phone number already exists'
      });
    }

    if (error.message.includes('Valid phone number is required')) {
      return res.status(400).json({
        success: false,
        message: 'Please provide a valid 10-digit phone number'
      });
    }

    res.status(500).json({
      success: false,
      message: 'An error occurred during signup',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Get current user
const getCurrentUser = async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    if (user.role === 'student') {
      const profile = await StudentProfile.findOne({ userId: user._id }).lean();
      const isComplete = profile ? isStudentProfileComplete(profile) : false;
      if (user.isProfileComplete !== isComplete) {
        user.isProfileComplete = isComplete;
        await user.save();
      }
    } else if (user.role === 'tutor') {
      const profile = await TutorProfile.findOne({ userId: user._id }).lean();
      const isComplete = profile ? isTutorProfileComplete(profile) : false;
      if (user.isProfileComplete !== isComplete) {
        user.isProfileComplete = isComplete;
        await user.save();
      }
    }

    res.status(200).json({
      success: true,
      user: {
        id: user._id,
        phone: user.phone,
        role: user.role,
        isProfileComplete: user.isProfileComplete
      }
    });
  } catch (error) {
    console.error('Get Current User Error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// Logout user
const logout = async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      return res.status(400).json({
        success: false,
        message: 'Refresh token is required'
      });
    }

    // Remove refresh token
    await tokenService.removeRefreshToken(req.user.id, refreshToken);

    res.status(200).json({
      success: true,
      message: 'Logged out successfully'
    });
  } catch (error) {
    console.error('Logout Error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// Refresh access token
const refreshToken = async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      return res.status(400).json({
        success: false,
        message: 'Refresh token is required'
      });
    }

    // Verify refresh token
    const decoded = tokenService.verifyRefreshToken(refreshToken);
    if (!decoded) {
      return res.status(401).json({
        success: false,
        message: 'Invalid refresh token'
      });
    }

    // Check if refresh token exists in database
    const user = await User.findById(decoded.id);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Generate new tokens
    const accessToken = tokenService.generateAccessToken(user._id, user.role);
    const newRefreshToken = tokenService.generateRefreshToken(user._id);

    // Replace old refresh token
    await tokenService.replaceRefreshToken(user._id, refreshToken, newRefreshToken);

    res.status(200).json({
      success: true,
      tokens: {
        accessToken,
        refreshToken: newRefreshToken,
        expiresIn: 3600
      }
    });
  } catch (error) {
    console.error('Refresh Token Error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

module.exports = {
  sendOTP,
  verifyOTP,
  adminLogin,
  getCurrentUser,
  logout,
  refreshToken
};
