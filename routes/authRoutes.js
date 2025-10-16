const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { authenticate } = require('../middleware/auth');

// Send OTP route
router.post('/send-otp', authController.sendOTP);

// Verify OTP route
router.post('/verify-otp', authController.verifyOTP);

// Get current user
router.get('/me', authenticate, authController.getCurrentUser);

// Logout route
router.post('/logout', authenticate, authController.logout);

// Refresh token route
router.post('/refresh-token', authController.refreshToken);

module.exports = router;