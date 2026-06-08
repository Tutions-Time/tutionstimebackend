const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const mongoose = require("mongoose");
const http = require("http");
const app = require("./app");
const User = require("./models/User");
const wsHub = require("./services/wsHub");

const PORT = process.env.PORT || 5000;

async function fixIndexes() {
  try {
    console.log("Checking and fixing database indexes...");

    const indexes = await User.collection.indexes();
    const hasPhoneIndex = indexes.some((i) => i.key && i.key.phone === 1);

    if (!hasPhoneIndex) {
      await User.collection.createIndex(
        { phone: 1 },
        { unique: true, sparse: true, background: true, name: "phone_1" }
      );
      console.log("Created phone index");
    } else {
      console.log("Phone index already exists, skipping");
    }

    // REMOVED: Auto-deletion of invalid users
    // const result = await User.deleteMany({
    //   $or: [{ phone: null }, { phone: { $exists: false } }, { phone: "" }],
    // });
    // console.log(`Removed ${result.deletedCount} invalid user documents`);
  } catch (err) {
    console.error("Index fix error:", err.message);
  }
}

const server = http.createServer(app);
wsHub.init(server);
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

mongoose
  .connect(process.env.MONGO_URI, {
    serverSelectionTimeoutMS: 15000,
  })
  .then(async (conn) => {
    console.log(`MongoDB Connected: ${conn.connection.host}`);
    await fixIndexes();
    if (typeof app.startBackgroundJobs === "function") {
      app.startBackgroundJobs();
    }
  })
  .catch((err) => {
    console.error("MongoDB connection error:", err.message);
  });

app.get("/health", (req, res) => {
  res.json({ status: "ok", message: "Server running fine" });
});
