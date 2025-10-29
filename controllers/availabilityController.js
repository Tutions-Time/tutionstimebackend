const Availability = require('../models/Availability');

// Tutor adds or updates available slots
exports.setSlots = async (req, res) => {
  try {
    const tutorId = req.user.id;
    const { slots } = req.body; // [{ startTime, endTime }]

    if (!Array.isArray(slots) || slots.length === 0)
      return res.status(400).json({ success: false, message: 'No slots provided' });

    for (const s of slots) {
      await Availability.updateOne(
        { tutorId, startTime: s.startTime },
        {
          tutorId,
          startTime: s.startTime,
          endTime: s.endTime,
          isBooked: false,
          slotType: s.slotType || 'demo'
        },
        { upsert: true }
      );
    }

    res.status(200).json({ success: true, message: 'Availability updated' });
  } catch (err) {
    console.error('Error in setSlots:', err);
    res.status(500).json({ success: false, message: 'Failed to set availability' });
  }
};

// Get tutor’s free slots (for students)
exports.getTutorSlots = async (req, res) => {
  try {
    const { tutorId } = req.params;
    const type = req.query.type || 'demo';
    const slots = await Availability.find({ tutorId, isBooked: false, slotType: type })
      .sort({ startTime: 1 });
    res.status(200).json({ success: true, data: slots });
  } catch (err) {
    console.error('Error fetching slots:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch slots' });
  }
};

// Internal helper: mark slot booked
exports.markSlotBooked = async (tutorId, startTime) => {
  await Availability.updateOne({ tutorId, startTime }, { isBooked: true });
};

// Internal helper: release slot if cancelled
exports.releaseSlot = async (tutorId, startTime) => {
  await Availability.updateOne({ tutorId, startTime }, { isBooked: false });
};
