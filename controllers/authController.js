const User = require('../models/User');
const otpService = require('../services/otpService');
const tokenService = require('../services/tokenService');
const bcrypt = require('bcryptjs');

// Admin credentials (Move to environment variables in production)
const ADMIN_USERNAME = 'admin';
const ADMIN_PASSWORD = '$2a$10$yYQaJrHzjOgD5wWCud6khOiZEf97/K0ODwqf4GksCgP.b2FoGwuQy'; // "admin123"

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
    
    console.log('Verify OTP Request:', {
      phone,
      otp,
      requestId,
      role,
      timestamp: new Date().toISOString()
    });
    
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
    const verification = otpService.verifyOTP(requestId, otp);
    
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
      // Log the user data before creation
      console.log('Creating new user with data:', {
        phone: phone.trim(),
        role,
        isProfileComplete: false,
        status: 'active'
      });

      // Create new user
      user = await User.create({
        phone: phone.trim(),
        role,
        isProfileComplete: false,
        status: 'active'
      });

      console.log('User created successfully:', {
        id: user._id,
        phone: user.phone,
        role: user.role
      });
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