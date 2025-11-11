// controllers/enquiryController.js
const Enquiry = require('../models/Enquiry');
const TutorProfile = require('../models/TutorProfile');
const StudentProfile = require('../models/StudentProfile');
const notificationService = require('../services/notificationService');

/**
 * POST /api/enquiries
 */
exports.createEnquiry = async (req, res) => {
  try {
    const { tutorId, subject, message } = req.body;
    if (!tutorId || !subject || !message) {
      return res.status(400).json({ success: false, message: 'tutorId, subject, message are required' });
    }

    const enquiry = await Enquiry.create({
      studentId: req.user.id,
      tutorId,
      subject,
      message,
      status: 'open',
    });

    // Notify tutor
    try {
      const student = await StudentProfile.findOne({ userId: req.user.id }).lean();
      const tutor = await TutorProfile.findOne({ userId: tutorId }).lean();
      if (tutor?.email) {
        await notificationService.sendEmail(
          tutor.email,
          'New Enquiry Received',
          `${student?.name || 'A student'} sent an enquiry: ${subject}`
        );
      }
    } catch (e) {
      console.warn('enquiry notify tutor failed:', e.message);
    }

    res.status(201).json({ success: true, data: enquiry });
  } catch (err) {
    console.error('createEnquiry error:', err);
    res.status(500).json({ success: false, message: 'Failed to create enquiry' });
  }
};

/**
 * GET /api/enquiries/student
 */
exports.getStudentEnquiries = async (req, res) => {
  try {
    const enquiries = await Enquiry.find({ studentId: req.user.id })
      .populate('tutorId', 'name email')
      .sort({ createdAt: -1 })
      .lean();

    res.json({ success: true, data: enquiries });
  } catch (err) {
    console.error('getStudentEnquiries error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch enquiries' });
  }
};

/**
 * GET /api/enquiries/tutor
 */
exports.getTutorEnquiries = async (req, res) => {
  try {
    const enquiries = await Enquiry.find({ tutorId: req.user.id })
      .populate('studentId', 'name email')
      .sort({ createdAt: -1 })
      .lean();

    res.json({ success: true, data: enquiries });
  } catch (err) {
    console.error('getTutorEnquiries error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch enquiries' });
  }
};

/**
 * PATCH /api/enquiries/:id/reply
 */
exports.replyToEnquiry = async (req, res) => {
  try {
    const { id } = req.params;
    const { reply } = req.body;
    if (!reply || !reply.trim()) {
      return res.status(400).json({ success: false, message: 'Reply cannot be empty' });
    }

    const enquiry = await Enquiry.findById(id);
    if (!enquiry) return res.status(404).json({ success: false, message: 'Enquiry not found' });
    if (enquiry.tutorId.toString() !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    enquiry.reply = reply.trim();
    enquiry.status = 'replied';
    await enquiry.save();

    // Notify student
    try {
      const student = await StudentProfile.findOne({ userId: enquiry.studentId }).lean();
      if (student?.email) {
        await notificationService.sendEmail(
          student.email,
          'Tutor Replied to Your Enquiry',
          enquiry.reply
        );
      }
    } catch (e) {
      console.warn('enquiry notify student failed:', e.message);
    }

    res.json({ success: true, data: enquiry });
  } catch (err) {
    console.error('replyToEnquiry error:', err);
    res.status(500).json({ success: false, message: 'Failed to reply to enquiry' });
  }
};
