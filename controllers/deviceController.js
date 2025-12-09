const DeviceToken = require('../models/DeviceToken');

exports.register = async (req, res) => {
  try {
    const { token, platform, provider, meta } = req.body;
    if (!token) return res.status(400).json({ success: false, message: 'token required' });
    let existing = await DeviceToken.findOne({ token });
    if (existing) {
      existing.userId = req.user.id;
      existing.platform = platform || existing.platform;
      existing.provider = provider || existing.provider;
      existing.enabled = true;
      existing.lastActive = new Date();
      existing.meta = meta || existing.meta || {};
      await existing.save();
      return res.status(200).json({ success: true, data: existing });
    }
    const dt = await DeviceToken.create({ userId: req.user.id, token, platform: platform || 'web', provider: provider || (process.env.PUSH_PROVIDER || 'fcm'), meta: meta || {} });
    res.status(201).json({ success: true, data: dt });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to register device token' });
  }
};

exports.listMine = async (req, res) => {
  try {
    const list = await DeviceToken.find({ userId: req.user.id }).sort({ updatedAt: -1 }).lean();
    res.status(200).json({ success: true, data: list });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to list device tokens' });
  }
};

exports.remove = async (req, res) => {
  try {
    const { id } = req.params;
    const dt = await DeviceToken.findOne({ _id: id, userId: req.user.id });
    if (!dt) return res.status(404).json({ success: false, message: 'Not found' });
    await dt.deleteOne();
    res.status(200).json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to remove token' });
  }
};

exports.toggleEnable = async (req, res) => {
  try {
    const { id } = req.params;
    const { enabled } = req.body;
    const dt = await DeviceToken.findOneAndUpdate({ _id: id, userId: req.user.id }, { $set: { enabled: !!enabled } }, { new: true });
    if (!dt) return res.status(404).json({ success: false, message: 'Not found' });
    res.status(200).json({ success: true, data: dt });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to update token' });
  }
};

