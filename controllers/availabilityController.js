const Availability = require('../models/Availability');

// 🟢 Tutor adds or updates available slots
exports.setSlots = async (req, res) => {
  try {
    const tutorId = req.user.id;
    const { slots } = req.body; // [{ startTime, endTime?, slotType }]

    if (!Array.isArray(slots) || !slots.length)
      return res.status(400).json({ success: false, message: 'No slots provided' });

    const now = new Date();
    const bulkOps = [];

    for (const s of slots) {
      if (!s.startTime)
        return res.status(400).json({ success: false, message: 'Missing startTime' });

      const slotType = s.slotType || 'demo';
      let startTime = new Date(s.startTime);
      let endTime;

      // Auto-set 15-minute duration for demo slots
      if (slotType === 'demo') {
        endTime = new Date(startTime.getTime() + 15 * 60000);
      } else {
        if (!s.endTime)
          return res.status(400).json({
            success: false,
            message: 'Regular slot must include endTime',
          });
        endTime = new Date(s.endTime);
      }

      if (endTime <= startTime)
        return res.status(400).json({ success: false, message: 'Invalid time range' });

      if (endTime <= now)
        return res.status(400).json({ success: false, message: 'Cannot create past slot' });

      // Optional: prevent overlapping slots
      const overlap = await Availability.findOne({
        tutorId,
        $or: [
          { startTime: { $lt: endTime }, endTime: { $gt: startTime } }
        ]
      });
      if (overlap) {
        return res.status(400).json({
          success: false,
          message: 'One or more slots overlap with existing availability',
        });
      }

      bulkOps.push({
        updateOne: {
          filter: { tutorId, startTime },
          update: { tutorId, startTime, endTime, slotType, isBooked: false },
          upsert: true,
        },
      });
    }

    await Availability.bulkWrite(bulkOps);

    const updatedSlots = await Availability.find({ tutorId }).sort({ startTime: 1 });
    res.status(200).json({
      success: true,
      message: 'Availability updated successfully',
      data: updatedSlots,
    });
  } catch (err) {
    console.error('Error in setSlots:', err);
    res.status(500).json({ success: false, message: 'Failed to set availability' });
  }
};

// 🟢 Tutor views their own slots
exports.getMySlots = async (req, res) => {
  try {
    const tutorId = req.user.id;
    const now = new Date();

    const slots = await Availability.find({ tutorId, endTime: { $gte: now } })
      .sort({ startTime: 1 });

    res.json({ success: true, data: slots });
  } catch (err) {
    console.error('Error fetching my slots:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch slots' });
  }
};

// 🟢 Student fetches tutor’s free slots
exports.getTutorSlots = async (req, res) => {
  try {
    const { tutorId } = req.params;
    const type = req.query.type || 'demo';
    const limit = parseInt(req.query.limit) || 20;
    const page = parseInt(req.query.page) || 1;
    const now = new Date();

    const query = {
      tutorId,
      slotType: type,
      isBooked: false,
      endTime: { $gte: now },
    };

    const slots = await Availability.find(query)
      .sort({ startTime: 1 })
      .skip((page - 1) * limit)
      .limit(limit);

    const total = await Availability.countDocuments(query);

    res.json({
      success: true,
      total,
      page,
      pages: Math.ceil(total / limit),
      data: slots,
    });
  } catch (err) {
    console.error('Error fetching tutor slots:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch slots' });
  }
};

exports.deleteSlot = async (req, res) => {
  try {
    const { slotId } = req.params;
    const tutorId = req.user.id;

    const slot = await Availability.findOne({ _id: slotId, tutorId });
    if (!slot) {
      return res.status(404).json({ success: false, message: 'Slot not found or unauthorized' });
    }

    await Availability.deleteOne({ _id: slotId });
    res.status(200).json({ success: true, message: 'Slot deleted successfully' });
  } catch (err) {
    console.error('Error deleting slot:', err);
    res.status(500).json({ success: false, message: 'Failed to delete slot' });
  }
};


// 🟢 Internal helpers for booking flow
exports.markSlotBooked = async (tutorId, startTime) => {
  await Availability.updateOne({ tutorId, startTime }, { isBooked: true });
};

exports.releaseSlot = async (tutorId, startTime) => {
  await Availability.updateOne({ tutorId, startTime }, { isBooked: false });
};
