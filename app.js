const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const errorHandler = require("./middleware/errorHandler");
const connectDB = require("./config/database");
const path = require("path");

// Connect to MongoDB
connectDB();

const app = express();

// ==================== SECURITY MIDDLEWARE ====================
app.use(helmet());

// ==================== CORS CONFIGURATION ====================
// ✅ Allow all origins (safe for dev/public API)
const corsOptions = {
  origin: "*",
  methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "Accept",
    "X-Requested-With",
    "Origin",
  ],
  exposedHeaders: [
    "Content-Length",
    "X-RateLimit-Remaining",
    "X-RateLimit-Limit",
  ],
  optionsSuccessStatus: 200,
};

app.use(cors(corsOptions));
// Handle all preflight (OPTIONS) requests
app.options("*", cors(corsOptions));

// ==================== BODY PARSERS ====================
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ==================== STATIC FILES ====================
app.use("/uploads", express.static("uploads"));

app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// Routes
app.use('/api/auth', require('./routes/authRoutes'));
app.use('/api/users', require('./routes/userRoutes'));
app.use('/api/admin', require('./routes/adminRoutes'));
app.use('/api/subjects', require('./routes/subjectRoutes'));
app.use('/api/bookings', require('./routes/bookingRoutes'));
app.use('/api/availability', require('./routes/availabilityRoutes'));
// app.use('/api/payments', require('./routes/paymentRoutes'));
app.use('/api/wallet', require('./routes/walletRoutes'));
app.use('/api/tutors', require('./routes/tutorRoutes'));

app.use('/api/subscriptions', require('./routes/subscriptionRoutes'));


// ==================== ROUTES ====================
app.get("/", (req, res) =>
  res.status(200).json({ status: "CORS enabled and working!" })
);


// ==================== HEALTH & TEST ENDPOINTS ====================
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok" });
});

app.get("/api/test", (req, res) => {
  res.status(200).json({
    success: true,
    message: "API is working!",
    timestamp: new Date().toISOString(),
  });
});

// ==================== 404 HANDLER ====================
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "Endpoint not found",
  });
});

// ==================== ERROR HANDLER ====================
app.use(errorHandler);

// ==================== AUTO MARK COMPLETED CLASSES ====================
const cron = require("node-cron");
const Booking = require("./models/Booking");

// 🕒 Runs every minute (change to */10 for every 10 mins)
cron.schedule("*/1 * * * *", async () => {
  try {
    const now = new Date();

    // Find all confirmed sessions whose end time has passed
    const expiredBookings = await Booking.find({
      status: "confirmed",
      endTime: { $lt: now },
    });

    if (expiredBookings.length === 0) return;

    for (const booking of expiredBookings) {
      booking.status = "completed";
      booking.completedAt = now;
      await booking.save();
      console.log(`✅ Marked booking ${booking._id} as completed`);
    }

    console.log(`🔁 ${expiredBookings.length} bookings auto-completed at ${now.toLocaleString()}`);
  } catch (err) {
    console.error("❌ Error in auto-complete cron:", err.message);
  }
});


module.exports = app;
