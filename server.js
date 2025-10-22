require('dotenv').config();
const mongoose = require('mongoose');
const app = require('./app');
const User = require('./models/User');
 
const PORT = process.env.PORT || 3000;
 
// ✅ Function to fix indexes and clean invalid documents
async function fixIndexes() {
  try {
    console.log('🔍 Checking and fixing database indexes...');
 
    const currentIndexes = await User.collection.getIndexes();
    for (const indexName in currentIndexes) {
      if (indexName !== '_id_') {
        try {
          await User.collection.dropIndex(indexName);
          console.log(`🗑️ Dropped index: ${indexName}`);
        } catch {
          console.log(`⚠️ Skipped drop for index: ${indexName}`);
        }
      }
    }
 
    const result = await User.deleteMany({
      $or: [
        { phone: null },
        { phone: { $exists: false } },
        { phone: '' }
      ]
    });
    console.log(`🧹 Removed ${result.deletedCount} invalid user documents`);
 
    await User.collection.createIndex(
      { phone: 1 },
      { unique: true, background: true, sparse: true }
    );
    console.log('✅ Phone index OK');
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
  })
  .catch((err) => {
    console.error('❌ MongoDB connection error:', err.message);
  });
 
// ✅ Health check route
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'Server running fine ✅' });
});
 
// ✅ Export app (Passenger handles listen internally in cPanel)
module.exports = app;
