const tokenService = require('../services/tokenService');

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
    
    // Add user data to request
    req.user = {
      id: verification.decoded.userId,
      role: verification.decoded.role
    };
    
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
const checkRole = (role) => {
  return (req, res, next) => {
    if (req.user.role !== role) {
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