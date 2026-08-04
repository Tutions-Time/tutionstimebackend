const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const { authenticate, checkRole } = require('../middleware/auth');
const { getBookingByIdForAdmin } = require('../controllers/bookingController');
const uploadS3 = require('../middleware/uploadS3');
const blogController = require('../controllers/blogController');
const suspensionController = require('../controllers/suspensionController');


const adminTutorController = require('../controllers/adminTutorController.js');

// Apply admin authentication to all routes
router.use(authenticate, checkRole('admin'));

// Get all users
router.get('/users', adminController.getAllUsers);
router.get('/suspensions/:id', suspensionController.getAdminSuspensionAppeal);

router.put('/users/:id/status',  adminController.updateUserStatus);

// Get user by ID
router.get('/users/:userId', adminController.getUserById);

// Delete user (soft delete)
router.delete('/users/:userId', adminController.deleteUser);

// Permanently delete user (hard delete)
router.delete('/users/:userId/hard', adminController.hardDeleteUser);

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
router.get('/bookings/:id', getBookingByIdForAdmin);
router.get('/bookings', adminController.listAdminBookings);
router.patch('/bookings/:id/accept', adminController.acceptAdminDemoBooking);
router.patch('/bookings/:id/cancel', adminController.cancelAdminDemoBooking);
router.delete('/bookings/:id', adminController.deleteAdminDemoBooking);

router.get('/dashboard/stats', adminController.getDashboardStats);
router.get('/dashboard/activity', adminController.getDashboardActivity);
router.get('/sessions', adminController.listAdminSessions);
router.patch('/sessions/:id/schedule', adminController.updateAdminSessionSchedule);
router.get('/classes-monitor', adminController.listAdminClassesMonitor);
router.post('/uploads/migrate-to-s3', adminController.migrateUploadsToS3);

router.get('/blogs', blogController.listAdminBlogs);
router.get('/blogs/:id', blogController.getAdminBlogById);
router.post('/blogs', uploadS3.single('image'), blogController.createBlog);
router.put('/blogs/:id', uploadS3.single('image'), blogController.updateBlog);
router.delete('/blogs/:id', blogController.deleteBlog);

// バ. Tutor journey (demos, sessions, batches, notes, payments)
router.get('/tutors/:id/journey', adminTutorController.getTutorJourney);

module.exports = router;


