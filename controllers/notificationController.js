const Notification = require('../models/Notification');
const User = require('../models/User');

exports.listMine = async (req, res) => {
  try {
    const items = await Notification.find({ userId: req.user.id }).sort({ createdAt: -1 }).lean();
    res.status(200).json({ success: true, data: items });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch notifications' });
  }
};

exports.markRead = async (req, res) => {
  try {
    const { id } = req.params;
    const notif = await Notification.findOne({ _id: id, userId: req.user.id });
    if (!notif) return res.status(404).json({ success: false, message: 'Notification not found' });
    notif.read = true;
    await notif.save();
    res.status(200).json({ success: true, data: notif });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to update notification' });
  }
};

exports.markAllRead = async (req, res) => {
  try {
    await Notification.updateMany(
      { userId: req.user.id, read: { $ne: true } },
      { $set: { read: true } }
    );
    res.status(200).json({ success: true, message: 'All notifications marked as read' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to update notifications' });
  }
};

exports.deleteNotification = async (req, res) => {
  try {
    const { id } = req.params;
    const notif = await Notification.findOneAndDelete({ _id: id, userId: req.user.id });
    if (!notif) return res.status(404).json({ success: false, message: 'Notification not found' });
    res.status(200).json({ success: true, message: 'Notification deleted' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to delete notification' });
  }
};

exports.deleteAll = async (req, res) => {
  try {
    await Notification.deleteMany({ userId: req.user.id });
    res.status(200).json({ success: true, message: 'All notifications deleted' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to delete notifications' });
  }
};

exports.getPreferences = async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('notificationPrefs').lean();
    const prefs = user?.notificationPrefs || { email: true, push: true, inapp: true };
    res.status(200).json({ success: true, data: prefs });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to get preferences' });
  }
};

exports.updatePreferences = async (req, res) => {
  try {
    const allowed = ['email', 'push', 'inapp'];
    const update = {};
    for (const k of allowed) {
      if (typeof req.body[k] === 'boolean') update[`notificationPrefs.${k}`] = req.body[k];
    }
    const user = await User.findByIdAndUpdate(req.user.id, { $set: update }, { new: true }).select('notificationPrefs');
    res.status(200).json({ success: true, data: user.notificationPrefs });
  } catch (err) {
    res.status(400).json({ success: false, message: 'Failed to update preferences' });
  }
};

