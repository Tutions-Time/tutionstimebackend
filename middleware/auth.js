const tokenService = require('../services/tokenService');
const User = require('../models/User');

const authenticate = async (req, res, next) => {
  try {
    // Get token from header
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        message: 'No token provided',
        error: 'UNAUTHORIZED'
      });
    }
    
    // Extract token
    const token = authHeader.split(' ')[1];
    
    // Verify token
    const verification = tokenService.verifyAccessToken(token);
    
    if (!verification.valid) {
      return res.status(401).json({
        success: false,
        message: 'Invalid or expired token',
        error: 'UNAUTHORIZED'
      });
    }
    
    if (verification.decoded.role === 'admin') {
      req.user = {
        id: verification.decoded.userId,
        role: 'admin'
      };
      return next();
    }

    const user = await User.findById(verification.decoded.userId).select('status role isDeleted');
    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'User not found',
        error: 'UNAUTHORIZED'
      });
    }

    if (user.isDeleted) {
      return res.status(403).json({
        success: false,
        message: 'Your account has been deleted.',
        error: 'DELETED'
      });
    }

    if (user.status === 'inactive' || user.status === 'suspended') {
      return res.status(403).json({
        success: false,
        message: 'Your account is blocked. Please contact support.',
        error: 'INACTIVE'
      });
    }

    const nextUser = {
      id: verification.decoded.userId,
      role: user.role
    };
    if (user.role === 'tutor') {
      const TutorProfile = require('../models/TutorProfile');
      const profile = await TutorProfile.findOne({ userId: verification.decoded.userId }).select('_id').lean();
      if (profile?._id) nextUser.profileId = profile._id;
    }
    req.user = nextUser;
    
    next();
  } catch (error) {
    console.error('Authentication Error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};

// Check if user has required role
const checkRole = (roles) => {
  return (req, res, next) => {
    // roles can be string or array
    const allowedRoles = Array.isArray(roles) ? roles : [roles];

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: 'Access denied',
        error: 'FORBIDDEN'
      });
    }
    next();
  };
};


module.exports = { authenticate, checkRole };
