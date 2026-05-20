const Joi = require("joi");
const Note = require("../models/Note");
const Payment = require("../models/Payment");
const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const AWS_BUCKET = process.env.AWS_S3_BUCKET || process.env.AWS_BUCKET;
const AWS_REGION = process.env.AWS_REGION;
const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY;
const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY || process.env.AWS_SECRET_KEY;
const canSignS3Urls = Boolean(
  AWS_BUCKET && AWS_REGION && AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY,
);
const s3 = canSignS3Urls
  ? new S3Client({
      region: AWS_REGION,
      credentials: {
        accessKeyId: AWS_ACCESS_KEY_ID,
        secretAccessKey: AWS_SECRET_ACCESS_KEY,
      },
    })
  : null;

const isAwsUrl = (value) =>
  /^https?:\/\/[^/]+\.s3[.-][^/]*amazonaws\.com\//i.test(String(value || ""));

const createSchema = Joi.object({
  title: Joi.string().min(2).max(150).required(),
  description: Joi.string().allow(""),
  subject: Joi.string().required(),
  classLevel: Joi.string().required(),
  board: Joi.string().required(),
  price: Joi.number().min(0).required(),
});

exports.createNote = async (req, res) => {
  try {
    const tutorUserId = req.user.id;

    const { error, value } = createSchema.validate(req.body);
    if (error) {
      return res.status(400).json({ success: false, message: error.message });
    }

    if (!req.files || !req.files.pdf || !req.files.pdf[0]) {
      return res.status(400).json({ success: false, message: "PDF file is required" });
    }

    const pdfFile = req.files.pdf[0];
    const previewFiles = (req.files.previews || []).map((f) => f);

    const doc = {
      title: value.title,
      description: value.description || "",
      subject: value.subject,
      classLevel: value.classLevel,
      board: value.board,
      price: value.price,
      pdfUrl: pdfFile.location,
      pdfKey: pdfFile.key,
      previewImageUrls: previewFiles.map((f) => f.location),
      previewImageKeys: previewFiles.map((f) => f.key),
      tutorId: req.user.profileId || req.user.id,
    };

    try {
      const note = await Note.create(doc);
      return res.json({ success: true, data: note });
    } catch (errCreate) {
      throw errCreate;
    }
  } catch (err) {
    console.error("createNote error:", err);
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

exports.getMyNotes = async (req, res) => {
  try {
    const page = parseInt(req.query.page || "1", 10);
    const limit = parseInt(req.query.limit || "10", 10);
    const skip = (page - 1) * limit;

    const tutorId = req.user.profileId || req.user.id;

    const [items, total] = await Promise.all([
      Note.find({ tutorId }).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Note.countDocuments({ tutorId }),
    ]);

    return res.json({ success: true, data: items, pagination: { page, limit, total } });
  } catch (err) {
    console.error("getMyNotes error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

const updateSchema = Joi.object({
  title: Joi.string().min(2).max(150),
  description: Joi.string().allow(""),
  subject: Joi.string(),
  classLevel: Joi.string(),
  board: Joi.string(),
  price: Joi.number().min(0),
});

exports.updateNote = async (req, res) => {
  try {
    const { id } = req.params;
    const tutorId = req.user.profileId || req.user.id;
    const { error, value } = updateSchema.validate(req.body);
    if (error) return res.status(400).json({ success: false, message: error.message });

    const note = await Note.findById(id);
    if (!note) return res.status(404).json({ success: false, message: "Note not found" });
    if (String(note.tutorId) !== String(tutorId)) {
      return res.status(403).json({ success: false, message: "Not authorized" });
    }

    if (req.files?.pdf?.[0]) {
      const pdfFile = req.files.pdf[0];
      note.pdfUrl = pdfFile.location;
      note.pdfKey = pdfFile.key;
    }
    if (req.files?.previews?.length) {
      note.previewImageUrls = req.files.previews.map((f) => f.location);
      note.previewImageKeys = req.files.previews.map((f) => f.key);
    }

    Object.assign(note, value);
    await note.save();

    return res.json({ success: true, data: note });
  } catch (err) {
    console.error("updateNote error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

exports.deleteNote = async (req, res) => {
  try {
    const { id } = req.params;
    const tutorId = req.user.profileId || req.user.id;
    const note = await Note.findById(id);
    if (!note) return res.status(404).json({ success: false, message: "Note not found" });
    if (String(note.tutorId) !== String(tutorId)) {
      return res.status(403).json({ success: false, message: "Not authorized" });
    }
    await Note.deleteOne({ _id: id });
    return res.json({ success: true });
  } catch (err) {
    console.error("deleteNote error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

exports.searchNotes = async (req, res) => {
  try {
    const { q, subject, classLevel, board } = req.query;
    const page = parseInt(req.query.page || "1", 10);
    const limit = parseInt(req.query.limit || "12", 10);
    const skip = (page - 1) * limit;

    const filter = {};
    if (subject) filter.subject = subject;
    if (classLevel) filter.classLevel = classLevel;
    if (board) filter.board = board;
    if (q) filter.$text = { $search: q };

    const [items, total] = await Promise.all([
      Note.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Note.countDocuments(filter),
    ]);

    return res.json({ success: true, data: items, pagination: { page, limit, total } });
  } catch (err) {
    console.error("searchNotes error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

exports.getPurchasedNotes = async (req, res) => {
  try {
    const userId = req.user.id;
    const StudentProfile = require("../models/StudentProfile");
    const sp = await StudentProfile.findOne({ userId }).select("_id");
    const studentId = sp?._id || userId;
    const payments = await Payment.find({
      type: "note",
      status: "paid",
      studentId,
    })
      .select("noteId amount currency tutorId createdAt")
      .lean();

    const noteIds = payments.map((p) => p.noteId).filter(Boolean);
    const notes = await Note.find({ _id: { $in: noteIds } }).lean();

    const byId = new Map(notes.map((n) => [String(n._id), n]));
    const data = payments.map((p) => ({
      note: byId.get(String(p.noteId)),
      purchase: p,
    }));

    return res.json({ success: true, data });
  } catch (err) {
    console.error("getPurchasedNotes error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

exports.getDownloadUrl = async (req, res) => {
  try {
    const studentId = req.user.profileId || req.user.id;
    const { id } = req.params;

    const payment = await Payment.findOne({ type: "note", status: "paid", studentId, noteId: id });
    if (!payment) {
      return res.status(403).json({ success: false, message: "Not purchased" });
    }
    if (Number(payment.refundTotal || 0) >= Number(payment.amount || 0)) {
      return res.status(403).json({ success: false, message: "Access revoked due to refund" });
    }

    const note = await Note.findById(id);
    if (!note) return res.status(404).json({ success: false, message: "Note not found" });

    if (!isAwsUrl(note.pdfUrl)) {
      return res.json({ success: true, url: note.pdfUrl });
    }

    if (!note.pdfKey || !canSignS3Urls) {
      return res.json({ success: true, url: note.pdfUrl });
    }

    const command = new GetObjectCommand({ Bucket: AWS_BUCKET, Key: note.pdfKey });
    const signedUrl = await getSignedUrl(s3, command, { expiresIn: 60 });

    return res.json({ success: true, url: signedUrl });
  } catch (err) {
    console.error("getDownloadUrl error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};
