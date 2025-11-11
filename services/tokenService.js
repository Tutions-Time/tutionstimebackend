const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const User = require('../models/User');

// Generate access token
const generateAccessToken = (userId, role) => {
  return jwt.sign(
    { userId, role },
    process.env.JWT_ACCESS_SECRET,
    { expiresIn: '30d' }
  );
};

// Generate refresh token
const generateRefreshToken = (userId) => {
  const refreshToken = jwt.sign(
    { userId },
    process.env.JWT_REFRESH_SECRET,
    { expiresIn: '30d' }
  );
  
  return refreshToken;
};

// Verify access token
const verifyAccessToken = (token) => {
  try {
    const decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET);
    return { valid: true, decoded };
  } catch (error) {
    return { valid: false, error: error.message };
  }
};

// Verify refresh token
const verifyRefreshToken = async (token) => {
  try {
    const decoded = jwt.verify(token, process.env.JWT_REFRESH_SECRET);
    
    // Check if the token exists in the database
    const user = await User.findOne({
      _id: decoded.userId,
      refreshToken: token
    });
    
    if (!user) {
      return { valid: false, error: 'Invalid refresh token' };
    }
    
    return { valid: true, userId: user._id, role: user.role };
  } catch (error) {
    return { valid: false, error: error.message };
  }
};

// Save refresh token to user
const saveRefreshToken = async (userId, refreshToken) => {
  await User.findByIdAndUpdate(userId, { refreshToken });
};

// Remove refresh token from user
const removeRefreshToken = async (userId) => {
  await User.findByIdAndUpdate(userId, { refreshToken: null });
};

module.exports = {
  generateAccessToken,
  generateRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  saveRefreshToken,
  removeRefreshToken
};