const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const { authenticate, checkRole } = require('../middleware/auth');

// Apply admin authentication to all routes
router.use(authenticate, checkRole('admin'));

// Get all users
router.get('/users', adminController.getAllUsers);

// Get user by ID
router.get('/users/:userId', adminController.getUserById);

// Update user status
router.patch('/users/:userId/status', adminController.updateUserStatus);

// Verify tutor
router.patch('/tutors/:tutorId/verify', adminController.verifyTutor);

module.exports = router;