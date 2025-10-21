const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const errorHandler = require("./middleware/errorHandler");
const connectDB = require("./config/database");

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

// ==================== ROUTES ====================
app.get("/", (req, res) =>
  res.status(200).json({ status: "CORS enabled and working!" })
);

app.use("/api/auth", require("./routes/authRoutes"));
app.use("/api/users", require("./routes/userRoutes"));
app.use("/api/admin", require("./routes/adminRoutes"));
app.use("/api/subjects", require("./routes/subjectRoutes"));
app.use("/api/bookings", require("./routes/bookingRoutes"));
app.use("/api/wallet", require("./routes/walletRoutes"));

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

module.exports = app;
