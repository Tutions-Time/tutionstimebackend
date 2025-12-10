const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const errorHandler = require("./middleware/errorHandler");
const connectDB = require("./config/database");
const path = require("path");
// const adminNotificationRoutes=require('./routes/adminNotificationRoutes')
const paymentController = require("./controllers/paymentController");


// Connect to MongoDB
connectDB();

const app = express();


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

app.options("*", cors(corsOptions));
// Razorpay Webhook MUST use raw body
app.post(
  "/api/payments/razorpay/webhook",
  express.raw({ type: "application/json" }),
  paymentController.razorpayWebhook
);

app.post(
  "/api/payouts/razorpayx/webhook",
  express.raw({ type: "application/json" }),
  paymentController.razorpayxWebhook
);


app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  helmet({
    crossOriginResourcePolicy: false,
  })
);

app.use("/uploads", express.static("uploads"));

app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// Routes
app.use('/api/auth', require('./routes/authRoutes'));
app.use('/api/users', require('./routes/userRoutes'));
app.use('/api/admin', require('./routes/adminRoutes'));
app.use('/api/bookings', require('./routes/bookingRoutes'));
app.use('/api/enquiries', require('./routes/enquiryRoutes'));
app.use('/api/payments', require('./routes/paymentRoutes'));
app.use('/api/notes', require('./routes/noteRoutes'));
app.use('/api/wallet', require('./routes/walletRoutes'));
app.use('/api/tutors', require('./routes/tutorRoutes'));

app.use('/api/meta', require('./routes/metaRoutes.js'));
app.use('/api/admin/notifications', require('./routes/adminNotificationRoutes'));
app.use('/api/tutor-switch', require('./routes/tutorSwitch'));
app.use("/api/regular", require("./routes/regularClassRoutes.js"));
app.use("/api/progress", require("./routes/progressRoutes.js"));
app.use("/api/group-batches", require("./routes/groupBatchRoutes"));
app.use('/api/marketing', require('./routes/marketingRoutes'));
app.use('/api/notifications', require('./routes/notificationRoutes'));
app.use('/api/devices', require('./routes/deviceRoutes'));


const { autoCompletePastDemos } = require('./controllers/bookingController');
const { autoCompletePastSessions } = require('./controllers/sessionController');
const payoutScheduler = require('./services/cron/payoutScheduler');
const weeklyReportScheduler = require('./services/cron/weeklyReportScheduler');
const sessionReminderScheduler = require('./services/cron/sessionReminderScheduler');

app.use("/api/sessions", require("./routes/sessionRoutes"));

setInterval(() => {
  autoCompletePastDemos();
  autoCompletePastSessions();
}, 5 * 60 * 1000);
payoutScheduler.start();
payoutScheduler.start();
weeklyReportScheduler.start();
sessionReminderScheduler.start();


app.get("/", (req, res) =>
  res.status(200).json({ status: "CORS enabled and working!" })
);



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


app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "Endpoint not found",
  });
});


app.use(errorHandler);




module.exports = app;
