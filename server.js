require('dotenv').config();
const mongoose = require('mongoose');
const app = require('./app');
const User = require('./models/User');

const PORT = process.env.PORT || 5000;

// ✅ Function to fix indexes and clean invalid documents
async function fixIndexes() {
  try {
    console.log('🔍 Checking and fixing database indexes...');

    // Get all current indexes
    const indexes = await User.collection.indexes();
    const hasPhoneIndex = indexes.some(i => i.key && i.key.phone === 1);

    // If no phone index exists, create it
    if (!hasPhoneIndex) {
      await User.collection.createIndex(
        { phone: 1 },
        { unique: true, sparse: true, background: true, name: 'phone_1' }
      );
      console.log('✅ Created phone index');
    } else {
      console.log('ℹ️ Phone index already exists, skipping');
    }

    // Clean invalid users
    const result = await User.deleteMany({
      $or: [
        { phone: null },
        { phone: { $exists: false } },
        { phone: '' }
      ]
    });

    console.log(`🧹 Removed ${result.deletedCount} invalid user documents`);
  } catch (err) {
    console.error('❌ Index fix error:', err.message);
  }
}

// ✅ MongoDB connection
mongoose
  .connect(process.env.MONGO_URI, {
    serverSelectionTimeoutMS: 15000,
  })
  .then(async (conn) => {
    console.log(`✅ MongoDB Connected: ${conn.connection.host}`);
    await fixIndexes();

    // ✅ Start the Express server after DB connection
    app.listen(PORT, () => {
      console.log(`🚀 Server running on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('❌ MongoDB connection error:', err.message);
  });

// ✅ Health check route
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'Server running fine ✅' });
});
