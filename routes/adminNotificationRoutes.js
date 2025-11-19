const express = require('express');
const router = express.Router();
const { authenticate, checkRole } = require('../middleware/auth');
const adminNotificationController = require('../controllers/adminNotificationController');

// Sare routes admin auth ke saath
router.use(authenticate, checkRole('admin'));

// GET /api/admin/notifications
router.get('/', adminNotificationController.getNotifications);

// PATCH /api/admin/notifications/:id/read
router.patch('/:id/read', adminNotificationController.markAsRead);

// PATCH /api/admin/notifications/read-all
router.patch('/read-all', adminNotificationController.markAllAsRead);

module.exports = router;
