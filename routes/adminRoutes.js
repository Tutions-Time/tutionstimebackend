const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const { authenticate, checkRole } = require('../middleware/auth');

const adminTutorController = require('../controllers/adminTutorController.js');

// Apply admin authentication to all routes
router.use(authenticate, checkRole('admin'));

// Get all users
router.get('/users', adminController.getAllUsers);

router.put('/users/:id/status',  adminController.updateUserStatus);

// Get user by ID
router.get('/users/:userId', adminController.getUserById);

// Update user status
router.patch('/users/:userId/status', adminController.updateUserStatus);

// Verify tutor
router.patch('/tutors/:tutorId/verify', adminController.verifyTutor);


// ✅ Get all tutors
router.get('/tutors',  adminTutorController.getAllTutors);

// ✅ Update tutor KYC status
router.put('/tutors/:id/kyc',  adminTutorController.updateKycStatus);

// ✅ Update tutor account status (active / suspended)
router.put('/tutors/:id/status',  adminTutorController.updateTutorStatus);

module.exports = router;