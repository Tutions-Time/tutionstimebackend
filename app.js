const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const errorHandler = require("./middleware/errorHandler");
const path = require("path");
// const adminNotificationRoutes=require('./routes/adminNotificationRoutes')
const paymentController = require("./controllers/paymentController");

const app = express();

// app.use(helmet());

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

app.use((req, res, next) => {
  if (req.method !== "OPTIONS") return next();
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", corsOptions.methods.join(","));
  res.header("Access-Control-Allow-Headers", corsOptions.allowedHeaders.join(","));
  res.header("Access-Control-Max-Age", "86400");
  return res.sendStatus(corsOptions.optionsSuccessStatus);
});
// Razorpay webhooks must receive the raw body for signature verification.
app.post(
  "/api/payments/razorpay/webhook",
  express.raw({ type: "application/json" }),
  paymentController.razorpayWebhook,
);

app.post(
  "/api/payments/cashfree/webhook",
  express.raw({ type: "application/json" }),
  paymentController.cashfreeWebhook,
);

app.post(
  "/api/payouts/cashfree/webhook",
  express.raw({ type: "application/json" }),
  paymentController.cashfreePayoutWebhook,
);

const requestLogger = require("./middleware/requestLogger");

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// app.use(requestLogger);

app.use(
  helmet({
    crossOriginResourcePolicy: false,
  }),
);

app.use("/uploads", express.static("uploads"));

app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// Routes
app.use("/api/auth", require("./routes/authRoutes"));
app.use("/api/users", require("./routes/userRoutes"));
app.use("/api/admin", require("./routes/adminRoutes"));
app.use("/api/bookings", require("./routes/bookingRoutes"));
app.use("/api/enquiries", require("./routes/enquiryRoutes"));
app.use("/api/payments", require("./routes/paymentRoutes"));
app.use("/api/notes", require("./routes/noteRoutes"));
app.use("/api/wallet", require("./routes/walletRoutes"));
app.use("/api/tutors", require("./routes/tutorRoutes"));
app.use("/api/blogs", require("./routes/blogRoutes"));

app.use("/api/meta", require("./routes/metaRoutes.js"));
app.use(
  "/api/admin/notifications",
  require("./routes/adminNotificationRoutes"),
);
app.use("/api/tutor-switch", require("./routes/tutorSwitch"));
app.use("/api/regular", require("./routes/regularClassRoutes.js"));
app.use("/api/progress", require("./routes/progressRoutes.js"));
app.use("/api/group-batches", require("./routes/groupBatchRoutes"));
app.use("/api/marketing", require("./routes/marketingRoutes"));
app.use("/api/notifications", require("./routes/notificationRoutes"));
app.use("/api/devices", require("./routes/deviceRoutes"));
app.use("/api/zoom", require("./routes/zoomRoutes"));
app.use("/api/reschedules", require("./routes/rescheduleRoutes"));

const payoutScheduler = require("./services/cron/payoutScheduler");
const weeklyReportScheduler = require("./services/cron/weeklyReportScheduler");
const sessionReminderScheduler = require("./services/cron/sessionReminderScheduler");
require("./services/cron/batchScheduler");
const demoExpiryScheduler = require("./services/cron/demoExpiryScheduler");

app.use("/api/sessions", require("./routes/sessionRoutes"));

app.startBackgroundJobs = () => {
  payoutScheduler.start();
  weeklyReportScheduler.start();
  sessionReminderScheduler.start();
  demoExpiryScheduler.start();

  demoExpiryScheduler.runOnce();
  payoutScheduler.runOnce();
};

app.get("/", (req, res) =>
  res.status(200).json({ status: "CORS enabled and working!" }),
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
