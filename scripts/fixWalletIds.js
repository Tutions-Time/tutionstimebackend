const mongoose = require('mongoose');
const connectDB = require('../config/database');
const Transaction = require('../models/Transaction');
const Wallet = require('../models/Wallet');
const StudentProfile = require('../models/StudentProfile');
const TutorProfile = require('../models/TutorProfile');

async function mapProfileToUser(id) {
  if (!id) return null;
  const sp = await StudentProfile.findById(id).select('userId').lean();
  if (sp?.userId) return sp.userId;
  const tp = await TutorProfile.findById(id).select('userId').lean();
  if (tp?.userId) return tp.userId;
  return id;
}

async function run() {
  await connectDB();
  console.log('Connected');

  // Fix Transactions.userId
  const txs = await Transaction.find({}).select('_id userId').lean();
  let fixed = 0;
  for (const tx of txs) {
    const newUserId = await mapProfileToUser(tx.userId);
    if (String(newUserId) !== String(tx.userId)) {
      await Transaction.updateOne({ _id: tx._id }, { userId: newUserId });
      fixed++;
    }
  }
  console.log(`Transactions fixed: ${fixed}`);

  // Fix Wallets.userId
  const wallets = await Wallet.find({}).select('_id userId').lean();
  let wfixed = 0;
  for (const w of wallets) {
    const newUserId = await mapProfileToUser(w.userId);
    if (String(newUserId) !== String(w.userId)) {
      await Wallet.updateOne({ _id: w._id }, { userId: newUserId });
      wfixed++;
    }
  }
  console.log(`Wallets fixed: ${wfixed}`);

  await mongoose.connection.close();
  console.log('Done');
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
