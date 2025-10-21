const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const errorHandler = require('./middleware/errorHandler');

const connectDB = require('./config/database');

// Connect to MongoDB
connectDB();

const app = express();

// Security middleware
app.use(helmet());
app.use(cors());

// Body parser
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files from uploads directory
app.use('/uploads', express.static('uploads'));

// Routes
app.use('/api/auth', require('./routes/authRoutes'));
app.use('/api/users', require('./routes/userRoutes'));
app.use('/api/admin', require('./routes/adminRoutes'));
app.use('/api/subjects', require('./routes/subjectRoutes'));
app.use('/api/bookings', require('./routes/bookingRoutes'));
app.use('/api/availability', require('./routes/availabilityRoutes'));
// app.use('/api/payments', require('./routes/paymentRoutes'));
app.use('/api/wallet', require('./routes/walletRoutes'));

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

// Mock endpoint for testing
app.get('/api/test', (req, res) => {
  res.status(200).json({ 
    success: true, 
    message: 'API is working!',
    timestamp: new Date().toISOString()
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Endpoint not found'
  });
});

// Error handling
app.use(errorHandler);

module.exports = app;