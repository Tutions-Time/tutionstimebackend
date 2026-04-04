const mongoose = require('mongoose');

const ensurePhoneIndex = async () => {
  const User = require('../models/User');
  try {
    await User.collection.dropIndex('phone_1');
  } catch {}

  try {
    await User.collection.createIndex({ phone: 1 }, { sparse: true });
  } catch (error) {
    console.warn('Unable to ensure phone index:', error.message);
  }
};

const connectDB = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/tuitionstime', {
      useNewUrlParser: true,
      useUnifiedTopology: true,
      serverSelectionTimeoutMS: 30000,
    });
    await ensurePhoneIndex();
    // console.log(`MongoDB Connected: ${conn.connection.host}`);
  } catch (error) {
    console.error(`Error connecting to MongoDB: ${error.message}`);
    process.exit(1);
  }
};

module.exports = connectDB;
