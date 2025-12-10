const User = require('../models/User');
const StudentProfile = require('../models/StudentProfile');
const TutorProfile = require('../models/TutorProfile');
const Session = require('../models/Session');
const Payment = require('../models/Payment');
const AdminWallet = require('../models/AdminWallet');
const RegularClass = require('../models/RegularClass');
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

// S3 config (support multiple env names)
const S3_BUCKET = process.env.AWS_S3_BUCKET || process.env.AWS_BUCKET;
const S3_REGION = process.env.AWS_REGION;
const S3_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY;
const S3_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY || process.env.AWS_SECRET_KEY;
const useS3 = Boolean(S3_BUCKET && S3_REGION && S3_ACCESS_KEY_ID && S3_SECRET_ACCESS_KEY);
const s3 = useS3 ? new S3Client({ region: S3_REGION, credentials: { accessKeyId: S3_ACCESS_KEY_ID, secretAccessKey: S3_SECRET_ACCESS_KEY } }) : null;

function guessContentType(filename) {
  const ext = String(filename).toLowerCase();
  if (ext.endsWith('.png')) return 'image/png';
  if (ext.endsWith('.jpg') || ext.endsWith('.jpeg')) return 'image/jpeg';
  if (ext.endsWith('.gif')) return 'image/gif';
  if (ext.endsWith('.svg')) return 'image/svg+xml';
  if (ext.endsWith('.pdf')) return 'application/pdf';
  if (ext.endsWith('.mp4')) return 'video/mp4';
  if (ext.endsWith('.webm')) return 'video/webm';
  if (ext.endsWith('.mov')) return 'video/quicktime';
  return 'application/octet-stream';
}

function extractLocalPath(url) {
  if (!url) return null;
  const str = String(url);
  const idx = str.indexOf('/uploads/');
  if (idx === -1) return null;
  const rel = str.substring(idx + 1); // 'uploads/...'
  const base = path.basename(rel);
  const p1 = path.join(process.cwd(), 'uploads', base);
  const p2 = path.join(__dirname, '..', 'uploads', base);
  if (fs.existsSync(p1)) return p1;
  if (fs.existsSync(p2)) return p2;
  return null;
}

async function putS3(buffer, key, contentType) {
  await s3.send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: key, Body: buffer, ContentType: contentType, ACL: 'public-read' }));
  return `https://${S3_BUCKET}.s3.${S3_REGION}.amazonaws.com/${key}`;
}

async function migrateField(doc, field, updates) {
  const url = doc[field];
  if (!url) return false;
  if (/s3\.amazonaws\.com\//i.test(String(url))) return false;
  const localPath = extractLocalPath(url);
  if (!localPath) return false;
  const buffer = fs.readFileSync(localPath);
  const base = path.basename(localPath);
  const key = `uploads/migrated/${base}`;
  const ct = guessContentType(base);
  const s3Url = await putS3(buffer, key, ct);
  updates[field] = s3Url;
  // add corresponding key fields where applicable
  if (field === 'pdfUrl') updates['pdfKey'] = key;
  return true;
}

async function migrateArrayField(doc, field, updates) {
  const arr = Array.isArray(doc[field]) ? doc[field] : [];
  if (!arr.length) return false;
  const migrated = [];
  for (const url of arr) {
    if (/s3\.amazonaws\.com\//i.test(String(url))) { migrated.push(url); continue; }
    const localPath = extractLocalPath(url);
    if (!localPath) { migrated.push(url); continue; }
    const buffer = fs.readFileSync(localPath);
    const base = path.basename(localPath);
    const key = `uploads/migrated/${base}`;
    const ct = guessContentType(base);
    const s3Url = await putS3(buffer, key, ct);
    migrated.push(s3Url);
  }
  updates[field] = migrated;
  if (field === 'previewImageUrls') updates['previewImageKeys'] = migrated.map((u) => {
    const idx = String(u).indexOf('/uploads/migrated/');
    return idx !== -1 ? String(u).substring(idx + 1) : '';
  });
  return true;
}

const migrateUploadsToS3 = async (req, res) => {
  try {
    if (!useS3) {
      return res.status(400).json({ success: false, message: 'S3 env vars not configured' });
    }

    const result = { StudentProfile: 0, TutorProfile: 0, Session: 0, Note: 0, missing: 0 };

    // StudentProfile: photoUrl
    const sps = await StudentProfile.find({ photoUrl: { $exists: true, $ne: null } });
    for (const sp of sps) {
      const updates = {};
      const ok = await migrateField(sp, 'photoUrl', updates);
      if (ok) { await StudentProfile.updateOne({ _id: sp._id }, { $set: updates }); result.StudentProfile++; }
      else if (!/s3\.amazonaws\.com\//.test(String(sp.photoUrl))) { result.missing++; }
    }

    // TutorProfile: photoUrl, resumeUrl, demoVideoUrl, aadhaarUrls, panUrl
    const tps = await TutorProfile.find({});
    for (const tp of tps) {
      const updates = {};
      await migrateField(tp, 'photoUrl', updates);
      await migrateField(tp, 'resumeUrl', updates);
      await migrateField(tp, 'demoVideoUrl', updates);
      await migrateArrayField(tp, 'aadhaarUrls', updates);
      await migrateField(tp, 'panUrl', updates);
      if (Object.keys(updates).length) { await TutorProfile.updateOne({ _id: tp._id }, { $set: updates }); result.TutorProfile++; }
    }

    // Session: recordingUrl, notesUrl, assignmentUrl
    const sess = await Session.find({});
    for (const s of sess) {
      const updates = {};
      await migrateField(s, 'recordingUrl', updates);
      await migrateField(s, 'notesUrl', updates);
      await migrateField(s, 'assignmentUrl', updates);
      if (Object.keys(updates).length) { await Session.updateOne({ _id: s._id }, { $set: updates }); result.Session++; }
    }

    // Note: pdfUrl, previewImageUrls
    const Note = require('../models/Note');
    const notes = await Note.find({});
    for (const n of notes) {
      const updates = {};
      await migrateField(n, 'pdfUrl', updates);
      await migrateArrayField(n, 'previewImageUrls', updates);
      if (Object.keys(updates).length) { await Note.updateOne({ _id: n._id }, { $set: updates }); result.Note++; }
    }

    return res.json({ success: true, message: 'Migration completed', result });
  } catch (err) {
    console.error('migrateUploadsToS3 error:', err);
    return res.status(500).json({ success: false, message: 'Server error', error: err.message });
  }
};

// Get all users with pagination + filters + search + referral fields
const getAllUsers = async (req, res) => {
  try {
    const { page = 1, limit = 20, role, status, q, sort = 'createdAt_desc' } = req.query;
    const pageNum = Math.max(1, Number(page));
    const limitNum = Math.max(1, Math.min(200, Number(limit)));
    const skip = Math.max(0, (pageNum - 1) * limitNum);

    const andClauses = [];
    if (role && ['student', 'tutor', 'admin'].includes(String(role))) andClauses.push({ role: role });
    if (status && ['active', 'inactive', 'suspended'].includes(String(status))) andClauses.push({ status: status });

    if (q && String(q).trim()) {
      const regex = new RegExp(String(q).trim(), 'i');
      const sp = await StudentProfile.find({ $or: [{ name: regex }, { email: regex }] }).select('userId').lean();
      const tp = await TutorProfile.find({ $or: [{ name: regex }, { email: regex }] }).select('userId').lean();
      const profileUserIds = [
        ...sp.map((x) => x.userId).filter(Boolean),
        ...tp.map((x) => x.userId).filter(Boolean),
      ].map((id) => new mongoose.Types.ObjectId(String(id)));
      const orClauses = [];
      if (profileUserIds.length) orClauses.push({ _id: { $in: profileUserIds } });
      orClauses.push({ phone: regex });
      orClauses.push({ email: regex });
      andClauses.push({ $or: orClauses });
    }

    const filter = andClauses.length ? { $and: andClauses } : {};

    let sortSpec = { createdAt: -1 };
    if (sort === 'createdAt_asc') sortSpec = { createdAt: 1 };
    else if (sort === 'lastActive_desc') sortSpec = { lastLogin: -1 };
    else if (sort === 'lastActive_asc') sortSpec = { lastLogin: 1 };

    const total = await User.countDocuments(filter);
    const users = await User.find(filter)
      .select('-password -refreshToken')
      .sort(sortSpec)
      .skip(skip)
      .limit(limitNum)
      .lean();

    const userIds = users.map((u) => u._id);
    const [studentProfiles, tutorProfiles] = await Promise.all([
      StudentProfile.find({ userId: { $in: userIds } }).lean(),
      TutorProfile.find({ userId: { $in: userIds } }).lean(),
    ]);
    const studentMap = new Map(studentProfiles.map((p) => [p.userId.toString(), p]));
    const tutorMap = new Map(tutorProfiles.map((p) => [p.userId.toString(), p]));

    // Referral: own code and used code
    let codeMap = new Map();
    try {
      const ReferralCode = require('../models/ReferralCode');
      const codes = await ReferralCode.find({ ownerUserId: { $in: userIds } }).select('ownerUserId code').lean();
      codeMap = new Map(codes.map((c) => [c.ownerUserId.toString(), c.code]));
    } catch (_) {}

    // Referrer resolution for display
    const referrerIds = users.map((u) => u.referrerUserId).filter(Boolean).map((id) => id.toString());
    let refRoleMap = new Map();
    let refTutorNameMap = new Map();
    let refStudentNameMap = new Map();
    if (referrerIds.length) {
      const refUsers = await User.find({ _id: { $in: referrerIds } }).select('_id role').lean();
      refRoleMap = new Map(refUsers.map((ru) => [ru._id.toString(), ru.role]));
      const refTutorProfiles = await TutorProfile.find({ userId: { $in: referrerIds } }).select('userId name').lean();
      refTutorNameMap = new Map(refTutorProfiles.map((p) => [p.userId.toString(), p.name]));
      const StudentProfile = require('../models/StudentProfile');
      const refStudentProfiles = await StudentProfile.find({ userId: { $in: referrerIds } }).select('userId name').lean();
      refStudentNameMap = new Map(refStudentProfiles.map((p) => [p.userId.toString(), p.name]));
    }

    const baseUrl = (process.env.BASE_URL || '').replace(/\/$/, '');
    const mergedUsers = users.map((u) => {
      let profile = null;
      let name = null;
      let email = null;
      let photoUrl = null;
      if (u.role === 'student' && studentMap.has(u._id.toString())) {
        profile = studentMap.get(u._id.toString());
      } else if (u.role === 'tutor' && tutorMap.has(u._id.toString())) {
        profile = tutorMap.get(u._id.toString());
      }
      if (profile) {
        name = profile.name || null;
        email = profile.email || null;
        if (profile.photoUrl) {
          photoUrl = /^https?:\/\//i.test(profile.photoUrl)
            ? profile.photoUrl
            : (baseUrl ? `${baseUrl}/${String(profile.photoUrl).replace(/^\//, '')}` : String(profile.photoUrl));
        }
      }
      return {
        _id: u._id,
        name,
        email,
        phone: u.phone,
        role: u.role,
        status: u.status,
        isProfileComplete: u.isProfileComplete,
        lastLogin: u.lastLogin,
        createdAt: u.createdAt,
        profilePhoto: photoUrl,
        referralCode: codeMap.get(u._id.toString()) || null,
        referralCodeUsed: u.referralCodeUsed || null,
        referrerUserId: u.referrerUserId || null,
        referrerName:
          (u.referrerUserId && (refTutorNameMap.get(u.referrerUserId.toString()) || refStudentNameMap.get(u.referrerUserId.toString()))) || null,
        referrerRole: (u.referrerUserId && refRoleMap.get(u.referrerUserId.toString())) || null,
      };
    });

    res.status(200).json({
      success: true,
      data: {
        users: mergedUsers,
        pagination: { total, page: pageNum, limit: limitNum, pages: Math.ceil(total / limitNum) },
      },
    });
  } catch (error) {
    console.error('Get All Users Error:', error);
    res.status(500).json({ success: false, message: 'Server error', error: error.message });
  }
};

// Get user details by ID
const getUserById = async (req, res) => {
  try {
    const { userId } = req.params;
    
    const user = await User.findById(userId).select('-refreshToken');
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }
    
    let profile;
    if (user.role === 'student') {
      profile = await StudentProfile.findOne({ userId });
    } else if (user.role === 'tutor') {
      profile = await TutorProfile.findOne({ userId });
    }
    
    res.status(200).json({
      success: true,
      data: {
        user,
        profile: profile || null
      }
    });
  } catch (error) {
    console.error('Get User By ID Error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};



// Verify tutor
const verifyTutor = async (req, res) => {
  try {
    const { tutorId } = req.params;
    const { isVerified } = req.body;
    
    if (isVerified === undefined) {
      return res.status(400).json({
        success: false,
        message: 'isVerified field is required'
      });
    }
    
    const tutorProfile = await TutorProfile.findOne({ userId: tutorId });
    
    if (!tutorProfile) {
      return res.status(404).json({
        success: false,
        message: 'Tutor profile not found'
      });
    }
    
    tutorProfile.isVerified = isVerified;
    await tutorProfile.save();
    
    res.status(200).json({
      success: true,
      message: `Tutor ${isVerified ? 'verified' : 'unverified'} successfully`,
      data: {
        tutorId,
        isVerified
      }
    });
  } catch (error) {
    console.error('Verify Tutor Error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};

const updateUserStatus = async (req, res) => {
  try {
    const userId = req.params.id;
    const { status } = req.body;

    if (!['active', 'inactive'].includes(status)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid status value. Use active or inactive.',
      });
    }

    const user = await User.findByIdAndUpdate(
      userId,
      { status },
      { new: true }
    ).select('-password -refreshToken');

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
      });
    }

    res.status(200).json({
      success: true,
      message: `User ${status === 'active' ? 'activated' : 'deactivated'} successfully`,
      user,
    });
  } catch (error) {
    console.error('Update User Status Error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message,
    });
  }
};

const getDashboardStats = async (req, res) => {
  try {
    const totalUsers = await User.countDocuments();
    const students = await User.countDocuments({ role: 'student' });
    const tutors = await User.countDocuments({ role: 'tutor' });
    const admins = await User.countDocuments({ role: 'admin' });

    const activeUsers = await User.countDocuments({ status: 'active' });
    const inactiveUsers = await User.countDocuments({ status: 'inactive' });

    const kycApproved = await TutorProfile.countDocuments({ kycStatus: 'approved' });
    const kycPending = await TutorProfile.countDocuments({ kycStatus: 'pending' });
    const kycRejected = await TutorProfile.countDocuments({ kycStatus: 'rejected' });

    const sessionsScheduled = await Session.countDocuments({ status: 'scheduled' });
    const sessionsCompleted = await Session.countDocuments({ status: 'completed' });
    const upcoming7d = await Session.countDocuments({ startDateTime: { $gte: new Date(), $lte: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) } });

    const subsPaidAgg = await Payment.aggregate([
      { $match: { type: 'subscription', status: 'paid' } },
      { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }
    ]);
    const notesPaidAgg = await Payment.aggregate([
      { $match: { type: 'note', status: 'paid' } },
      { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }
    ]);
    const payoutsAgg = await Payment.aggregate([
      { $match: { type: 'payout' } },
      { $group: { _id: null, created: { $sum: { $cond: [{ $eq: ['$status', 'created'] }, 1, 0] } }, settled: { $sum: { $cond: [{ $eq: ['$status', 'settled'] }, 1, 0] } }, commissionTotal: { $sum: '$commissionAmount' }, amountTotal: { $sum: '$amount' } } }
    ]);

    const adminWallet = await AdminWallet.findOne();

    const stats = {
      users: { total: totalUsers, students, tutors, admins, active: activeUsers, inactive: inactiveUsers },
      kyc: { approved: kycApproved, pending: kycPending, rejected: kycRejected },
      sessions: { scheduled: sessionsScheduled, completed: sessionsCompleted, upcoming7d },
      payments: {
        subscriptions: { totalAmount: subsPaidAgg[0]?.total || 0, count: subsPaidAgg[0]?.count || 0 },
        notes: { totalAmount: notesPaidAgg[0]?.total || 0, count: notesPaidAgg[0]?.count || 0 },
        payouts: { created: payoutsAgg[0]?.created || 0, settled: payoutsAgg[0]?.settled || 0, commissionTotal: payoutsAgg[0]?.commissionTotal || 0, amountTotal: payoutsAgg[0]?.amountTotal || 0 }
      },
      adminWallet: adminWallet ? { balance: adminWallet.balance || 0, holdAmount: adminWallet.holdAmount || 0 } : { balance: 0, holdAmount: 0 }
    };

    res.status(200).json({ success: true, stats });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error', error: error.message });
  }
};

const listAdminSessions = async (req, res) => {
  try {
    const { status, from, to, page = 1, limit = 50, student, tutor } = req.query;
    const pageNum = Math.max(1, Number(page));
    const limitNum = Math.max(1, Number(limit));
    const skip = Math.max(0, (pageNum - 1) * limitNum);

    if (status === 'not-scheduled') {
      const rcFilter = { scheduleStatus: 'not-scheduled' };
      if (student) {
        if (mongoose.isValidObjectId(student)) {
          const sp = await StudentProfile.findById(student).select('userId').lean();
          rcFilter.studentId = sp?.userId || new mongoose.Types.ObjectId(String(student));
        } else {
          const sps = await StudentProfile.find({ name: new RegExp(String(student), 'i') }).select('userId').lean();
          rcFilter.studentId = { $in: sps.map((x) => x.userId).filter(Boolean) };
        }
      }
      if (tutor) {
        if (mongoose.isValidObjectId(tutor)) {
          const tp = await TutorProfile.findById(tutor).select('userId').lean();
          rcFilter.tutorId = tp?.userId || new mongoose.Types.ObjectId(String(tutor));
        } else {
          const tps = await TutorProfile.find({ name: new RegExp(String(tutor), 'i') }).select('userId').lean();
          rcFilter.tutorId = { $in: tps.map((x) => x.userId).filter(Boolean) };
        }
      }

      const total = await RegularClass.countDocuments(rcFilter);
      const classes = await RegularClass.find(rcFilter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean();

      const studentIds = classes.map((c) => c.studentId).filter(Boolean);
      const tutorIds = classes.map((c) => c.tutorId).filter(Boolean);
      const [spList, tpList] = await Promise.all([
        StudentProfile.find({ userId: { $in: studentIds } }).select('name photoUrl userId').lean(),
        TutorProfile.find({ userId: { $in: tutorIds } }).select('name photoUrl userId').lean(),
      ]);
      const spMap = new Map(spList.map((s) => [String(s.userId), s]));
      const tpMap = new Map(tpList.map((t) => [String(t.userId), t]));

      const data = classes.map((c) => ({
        kind: 'regularClass',
        _id: c._id,
        status: 'not-scheduled',
        attendance: 'not-marked',
        startDateTime: c.startDate,
        subject: c.subject,
        regularClassId: { subject: c.subject },
        studentId: spMap.get(String(c.studentId)) || null,
        tutorId: tpMap.get(String(c.tutorId)) || null,
      }));

      return res.status(200).json({ success: true, data, pagination: { total, page: pageNum, limit: limitNum, pages: Math.ceil(total / limitNum) } });
    }

    const andClauses = [];
    if (status) andClauses.push({ status });
    if (from || to) {
      const range = {};
      if (from) range.$gte = new Date(from);
      if (to) range.$lte = new Date(to);
      andClauses.push({ startDateTime: range });
    }
    if (student) {
      if (mongoose.isValidObjectId(student)) {
        const sp = await StudentProfile.findById(student).select('_id userId').lean();
        const or = [];
        if (sp?._id) or.push({ studentId: sp._id });
        or.push({ studentId: new mongoose.Types.ObjectId(String(student)) });
        if (sp?.userId) or.push({ studentId: sp.userId });
        andClauses.push({ $or: or });
      } else {
        const sps = await StudentProfile.find({ name: new RegExp(String(student), 'i') }).select('_id userId').lean();
        const ids = sps.map((x) => x._id);
        const userIds = sps.map((x) => x.userId).filter(Boolean);
        andClauses.push({ $or: [ { studentId: { $in: ids } }, { studentId: { $in: userIds } } ] });
      }
    }
    if (tutor) {
      if (mongoose.isValidObjectId(tutor)) {
        const tp = await TutorProfile.findById(tutor).select('_id userId').lean();
        const or = [];
        if (tp?._id) or.push({ tutorId: tp._id });
        or.push({ tutorId: new mongoose.Types.ObjectId(String(tutor)) });
        if (tp?.userId) or.push({ tutorId: tp.userId });
        andClauses.push({ $or: or });
      } else {
        const tps = await TutorProfile.find({ name: new RegExp(String(tutor), 'i') }).select('_id userId').lean();
        const ids = tps.map((x) => x._id);
        const userIds = tps.map((x) => x.userId).filter(Boolean);
        andClauses.push({ $or: [ { tutorId: { $in: ids } }, { tutorId: { $in: userIds } } ] });
      }
    }
    const filter = andClauses.length ? { $and: andClauses } : {};

    const total = await Session.countDocuments(filter);
    const sessions = await Session.find(filter)
      .sort({ startDateTime: -1 })
      .skip(skip)
      .limit(limitNum)
      .populate({ path: 'regularClassId', select: 'subject planType studentId tutorId scheduleStatus startDate' })
      .populate({ path: 'studentId', select: 'name photoUrl' })
      .populate({ path: 'tutorId', select: 'name photoUrl' })
      .lean();

    return res.status(200).json({ success: true, data: sessions, pagination: { total, page: pageNum, limit: limitNum, pages: Math.ceil(total / limitNum) } });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Server error', error: error.message });
  }
};

module.exports = {
  getAllUsers,
  getUserById,
  updateUserStatus,
  verifyTutor,
  updateUserStatus,
  getDashboardStats
  ,listAdminSessions
  ,migrateUploadsToS3
};
