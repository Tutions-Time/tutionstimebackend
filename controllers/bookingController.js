const Booking = require('../models/Booking');

// Create a new booking
exports.createBooking = async (req, res) => {
  try {
    const { tutorId, subject, date, startTime, endTime, type, amount } = req.body;
    
    if (!tutorId || !subject || !date || !startTime || !endTime || !type) {
      return res.status(400).json({ 
        success: false, 
        message: 'Missing required booking information' 
      });
    }
    
    const booking = new Booking({
      studentId: req.user.id,
      tutorId,
      subject,
      date,
      startTime,
      endTime,
      type,
      amount: amount || 0,
      status: 'pending',
      paymentStatus: 'pending'
    });
    
    await booking.save();
    
    res.status(201).json({
      success: true,
      data: booking
    });
  } catch (error) {
    console.error('Error creating booking:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create booking'
    });
  }
};

// Get bookings for current user (student or tutor)
exports.getUserBookings = async (req, res) => {
  try {
    const userId = req.user.id;
    const userRole = req.user.role;
    
    let query = {};
    if (userRole === 'student') {
      query.studentId = userId;
    } else if (userRole === 'tutor') {
      query.tutorId = userId;
    }
    
    const bookings = await Booking.find(query).sort({ date: -1, startTime: -1 });
    
    res.status(200).json({
      success: true,
      data: bookings
    });
  } catch (error) {
    console.error('Error fetching bookings:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch bookings'
    });
  }
};

// Update booking status
exports.updateBookingStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    
    if (!status || !['pending', 'confirmed', 'cancelled', 'completed'].includes(status)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid booking status'
      });
    }
    
    const booking = await Booking.findById(id);
    
    if (!booking) {
      return res.status(404).json({
        success: false,
        message: 'Booking not found'
      });
    }
    
    // Check if user is authorized to update this booking
    const userId = req.user.id;
    const userRole = req.user.role;
    
    if (userRole === 'student' && booking.studentId.toString() !== userId) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to update this booking'
      });
    }
    
    if (userRole === 'tutor' && booking.tutorId.toString() !== userId) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to update this booking'
      });
    }
    
    booking.status = status;
    await booking.save();
    
    res.status(200).json({
      success: true,
      data: booking
    });
  } catch (error) {
    console.error('Error updating booking:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update booking'
    });
  }
};

// Add rating and feedback to a booking
exports.addRatingAndFeedback = async (req, res) => {
  try {
    const { id } = req.params;
    const { rating, feedback } = req.body;
    
    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({
        success: false,
        message: 'Rating must be between 1 and 5'
      });
    }
    
    const booking = await Booking.findById(id);
    
    if (!booking) {
      return res.status(404).json({
        success: false,
        message: 'Booking not found'
      });
    }
    
    // Only students can add ratings
    if (req.user.role !== 'student' || booking.studentId.toString() !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: 'Only students can rate their bookings'
      });
    }
    
    // Can only rate completed bookings
    if (booking.status !== 'completed') {
      return res.status(400).json({
        success: false,
        message: 'Can only rate completed bookings'
      });
    }
    
    booking.rating = rating;
    booking.feedback = feedback || '';
    await booking.save();
    
    res.status(200).json({
      success: true,
      data: booking
    });
  } catch (error) {
    console.error('Error adding rating:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to add rating'
    });
  }
};