const Booking = require('../models/Booking');
const TutorProfile = require('../models/TutorProfile');
const StudentProfile = require('../models/StudentProfile');
const User = require('../models/User'); // ✅ FIX 1: Added missing import
const notificationService = require('../services/notificationService');
const emailTpl = require('../templates/emailTemplates');

// Helper: normalize YYYY-MM-DD to start-of-day Date in IST-friendly way
function toStartOfDay(dateStr) {
  const d = new Date(dateStr);
  // Force 00:00 local time for consistency
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/**
 * POST /api/bookings/demo
 * Create a day-level demo booking (pending)
 */
exports.createDemoBooking = async (req, res) => {
  // console.log("data", req.body);
  try {
    const { tutorId, subject, date, note } = req.body;
    if (!tutorId || !subject || !date) {
      return res
        .status(400)
        .json({ success: false, message: "tutorId, subject, date are required" });
    }

    // Tutor must exist & be available that day (using TutorProfile.availability)
    const tutor = await TutorProfile.findOne({ _id: tutorId }).lean();
    if (!tutor) {
      return res
        .status(404)
        .json({ success: false, message: "Tutor not found" });
    }

    const preferredDate = toStartOfDay(date);
    const avail = Array.isArray(tutor.availability) ? tutor.availability : [];
    const isAvailable = avail.includes(date);
    if (!isAvailable) {
      return res
        .status(400)
        .json({ success: false, message: "Tutor not available on selected date" });
    }

    // ✅ FIX 3: Friendly duplicate booking error
    let booking;
    try {
      booking = await Booking.create({
        studentId: req.user.id,
        tutorId,
        subject,
        preferredDate,
        note: note || "",
        type: "demo",
        status: "pending",
        meetingLink: "",
      });
    } catch (err) {
      if (err.code === 11000) {
        return res.status(400).json({
          success: false,
          message: "You already booked a demo with this tutor for that date.",
        });
      }
      throw err;
    }

    // Notify tutor (HTML version)
    try {
      const student = await StudentProfile.findOne({ userId: req.user.id }).lean();

      if (tutor.email) {
        const html = emailTpl.tutorDemoRequestHTML({
          studentName: student?.name || "A student",
          subject,
          date,
        });

        await notificationService.sendEmail(
          tutor.email,
          "New Demo Request",
          "",
          html
        );
      }

      // ✅ FIX 4: In-app notification to tutor
      await notificationService.createInApp(
        tutor.userId || tutorId,
        "New Demo Request",
        `${student?.name || "A student"} requested a demo for ${subject} on ${date}`,
        { tutorId, subject, date }
      );
    } catch (e) {
      console.warn("Notification (tutor) failed:", e.message);
    }

    return res.status(201).json({ success: true, data: booking });
  } catch (err) {
    console.error("createDemoBooking error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to create demo booking" });
  }
};

/**
 * GET /api/bookings/student
 * Logged-in student's demo bookings
 */
exports.getStudentBookings = async (req, res) => {
  try {
    const bookings = await Booking.find({ studentId: req.user.id })
      .populate("tutorId", "name email")
      .sort({ createdAt: -1 })
      .lean();

    res.json({ success: true, data: bookings });
  } catch (err) {
    console.error("getStudentBookings error:", err);
    res
      .status(500)
      .json({ success: false, message: "Failed to fetch bookings" });
  }
};

/**
 * GET /api/bookings/tutor
 * Logged-in tutor's incoming demo requests
 */
exports.getTutorBookings = async (req, res) => {
  console.log("get booking")
  try {
    const bookings = await Booking.find({ tutorId: req.user.id })
      .populate("studentId", "name email")
      .sort({ createdAt: -1 })
      .lean();
    console.log("bookings", bookings)
    res.json({ success: true, data: bookings });
  } catch (err) {
    console.error("getTutorBookings error:", err);
    res
      .status(500)
      .json({ success: false, message: "Failed to fetch tutor bookings" });
  }
};

/**
 * PATCH /api/bookings/:id/status
 * Tutor accepts/rejects (confirm/cancel) a demo booking
 */
exports.updateDemoStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!["confirmed", "cancelled"].includes(status)) {
      return res.status(400).json({ success: false, message: "Invalid status" });
    }

    const booking = await Booking.findById(id);
    if (!booking)
      return res.status(404).json({ success: false, message: "Booking not found" });

    if (booking.tutorId.toString() !== req.user.id) {
      return res.status(403).json({ success: false, message: "Not authorized" });
    }

    // STATUS: CONFIRMED
    if (status === "confirmed") {
      booking.status = "confirmed";
      if (!booking.meetingLink) {
        booking.meetingLink = `https://meet.jit.si/tuitiontime-${Date.now()}`;
      }
      await booking.save();

      const tutorUser = await User.findById(booking.tutorId);
      const studentUser = await User.findById(booking.studentId);
      const tutorProfile = await TutorProfile.findOne({ userId: booking.tutorId }).lean();

      // Email to Student
      if (studentUser?.email) {
        const html = emailTpl.bookingConfirmedHTML({
          tutorName: tutorProfile?.name || "Your Tutor",
          subject: booking.subject,
          date: new Date(booking.preferredDate).toDateString(),
          link: booking.meetingLink,
        });
        await notificationService.sendEmail(
          studentUser.email,
          "Demo Confirmed - TuitionTime",
          "",
          html
        );
      }

      // Email to Tutor
      if (tutorUser?.email) {
        const html = emailTpl.bookingConfirmedHTML({
          tutorName: tutorProfile?.name,
          subject: booking.subject,
          date: new Date(booking.preferredDate).toDateString(),
          link: booking.meetingLink,
        });
        await notificationService.sendEmail(
          tutorUser.email,
          "Demo Confirmed - TuitionTime",
          "",
          html
        );
      }

      // ✅ Optional in-app notifications
      await notificationService.createInApp(
        booking.studentId,
        "Demo Confirmed",
        `Your demo with ${tutorProfile?.name} is confirmed.`,
        { meetingLink: booking.meetingLink }
      );

      return res.json({
        success: true,
        message:
          "Demo confirmed successfully and emails sent to both student & tutor.",
        data: booking,
      });
    }

    // STATUS: CANCELLED
    if (status === "cancelled") {
      booking.status = "cancelled";
      await booking.save();

      const tutorProfile = await TutorProfile.findOne({ userId: booking.tutorId }).lean();
      const studentUser = await User.findById(booking.studentId);

      if (studentUser?.email) {
        const html = emailTpl.bookingCancelledHTML({
          tutorName: tutorProfile?.name || "Your Tutor",
          subject: booking.subject,
        });
        await notificationService.sendEmail(
          studentUser.email,
          "Demo Cancelled - TuitionTime",
          "",
          html
        );
      }

      await notificationService.createInApp(
        booking.studentId,
        "Demo Cancelled",
        `Your demo with ${tutorProfile?.name} was cancelled.`,
        { tutorId: booking.tutorId }
      );

      return res.json({
        success: true,
        message:
          "Demo cancelled successfully and notification sent to student.",
        data: booking,
      });
    }
  } catch (err) {
    console.error("❌ updateDemoStatus error:", err);
    res.status(500).json({
      success: false,
      message: "Failed to update booking status",
      error: err.message,
    });
  }
};

/**
 * PATCH /api/bookings/:id/feedback
 * Student adds rating/feedback after completion
 */
exports.addFeedback = async (req, res) => {
  try {
    const { id } = req.params;
    const { rating, feedback } = req.body;

    const booking = await Booking.findById(id);
    if (!booking)
      return res.status(404).json({ success: false, message: "Booking not found" });
    if (booking.studentId.toString() !== req.user.id) {
      return res.status(403).json({ success: false, message: "Not authorized" });
    }
    if (!rating || rating < 1 || rating > 5) {
      return res
        .status(400)
        .json({ success: false, message: "Rating must be 1–5" });
    }

    booking.rating = rating;
    booking.feedback = feedback || "";
    if (booking.status === "confirmed") booking.status = "completed";

    await booking.save();

    // ✅ FIX 2: Send feedback email to tutor
    try {
      const student = await StudentProfile.findOne({ userId: req.user.id }).lean();
      const tutorProfile = await TutorProfile.findOne({ userId: booking.tutorId }).lean();
      const tutorUser = await User.findById(booking.tutorId);

      if (tutorUser?.email) {
        const html = emailTpl.tutorFeedbackReceivedHTML({
          studentName: student?.name || "A student",
          subject: booking.subject,
          rating,
          feedback,
        });
        await notificationService.sendEmail(
          tutorUser.email,
          "New Feedback Received - TuitionTime",
          "",
          html
        );
      }

      await notificationService.createInApp(
        booking.tutorId,
        "New Feedback Received",
        `${student?.name || "A student"} rated your demo ${rating}/5`,
        { bookingId: booking._id }
      );
    } catch (e) {
      console.warn("Feedback email failed:", e.message);
    }

    res.json({ success: true, data: booking });
  } catch (err) {
    console.error("addFeedback error:", err);
    res
      .status(500)
      .json({ success: false, message: "Failed to add feedback" });
  }
};
