const AdminNotification = require('../models/AdminNotification');

// GET /api/admin/notifications
exports.getNotifications = async (req, res) => {
  try {
    const notifications = await AdminNotification.find()
      .sort({ createdAt: -1 })
      .lean();

    res.status(200).json({
      success: true,
      data: notifications,
    });
  } catch (err) {
    console.error('getNotifications error:', err);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch admin notifications',
    });
  }
};

// PATCH /api/admin/notifications/:id/read
exports.markAsRead = async (req, res) => {
  try {
    const { id } = req.params;
    const notif = await AdminNotification.findById(id);

    if (!notif) {
      return res.status(404).json({
        success: false,
        message: 'Notification not found',
      });
    }

    notif.isRead = true;
    await notif.save();

    res.status(200).json({
      success: true,
      message: 'Notification marked as read',
      data: notif,
    });
  } catch (err) {
    console.error('markAsRead error:', err);
    res.status(500).json({
      success: false,
      message: 'Failed to update notification',
    });
  }
};

// PATCH /api/admin/notifications/read-all
exports.markAllAsRead = async (req, res) => {
  try {
    await AdminNotification.updateMany({ isRead: false }, { isRead: true });

    res.status(200).json({
      success: true,
      message: 'All notifications marked as read',
    });
  } catch (err) {
    console.error('markAllAsRead error:', err);
    res.status(500).json({
      success: false,
      message: 'Failed to update notifications',
    });
  }
};
