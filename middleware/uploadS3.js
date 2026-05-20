// middleware/uploadS3.js
//
// Kept under the same module name because routes already import uploadS3.
// New uploads are stored on this server only. Existing AWS URLs already saved
// in MongoDB are preserved by controllers and continue to be returned as-is.
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const uploadsDir = path.join(process.cwd(), "uploads");
try {
  fs.mkdirSync(uploadsDir, { recursive: true });
} catch (_) {}

const MAX_FILE_SIZES = {
  photo: 10 * 1024 * 1024,
  resume: 10 * 1024 * 1024,
  demoVideo: 200 * 1024 * 1024,
  recording: 200 * 1024 * 1024,
  pdf: 150 * 1024 * 1024,
  notes: 150 * 1024 * 1024,
  assignment: 150 * 1024 * 1024,
};
const GLOBAL_MAX_FILE_SIZE = 200 * 1024 * 1024;

function getSubdir(file) {
  switch (file.fieldname) {
    case "photo":
      return "photos";
    case "resume":
      return "resumes";
    case "aadhaar":
    case "pan":
    case "bankProof":
      return "kyc";
    case "demoVideo":
    case "recording":
      return "videos";
    case "certificate":
      return file.mimetype === "application/pdf"
        ? path.join("certificates", "pdfs")
        : path.join("certificates", "images");
    case "pdf":
    case "notes":
    case "assignment":
      return "documents";
    case "previews":
    case "image":
      return "images";
    default:
      return "misc";
  }
}

const storage = multer.diskStorage({
  destination: function (_req, file, cb) {
    const dest = path.join(uploadsDir, getSubdir(file));
    try {
      fs.mkdirSync(dest, { recursive: true });
      cb(null, dest);
    } catch (err) {
      cb(err);
    }
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname);
    const base = path
      .basename(file.originalname, ext)
      .replace(/[^A-Za-z0-9_-]/g, "_");
    const scope = req.params?.id || "general";
    const unique = `${file.fieldname}-${Date.now()}-${Math.round(
      Math.random() * 1e9,
    )}`;
    cb(null, `${scope}-${base}-${unique}${ext}`);
  },
});

const upload = multer({ storage, limits: { fileSize: GLOBAL_MAX_FILE_SIZE } });

function ensureLocations(req) {
  if (!req) return;

  const requestBaseUrl =
    req.protocol && req.get?.("host") ? `${req.protocol}://${req.get("host")}` : "";
  const baseUrl = process.env.BASE_URL || requestBaseUrl;
  const mapFile = (file) => {
    if (!file || file.location || !file.path) return;

    const rel = path.relative(process.cwd(), file.path).replace(/\\/g, "/");
    file.location = baseUrl
      ? `${baseUrl.replace(/\/$/, "")}/${rel}`
      : `/${rel}`;
    file.key = rel;
  };

  if (req.file) mapFile(req.file);
  if (Array.isArray(req.files)) {
    req.files.forEach(mapFile);
  } else if (req.files) {
    Object.values(req.files)
      .filter(Array.isArray)
      .forEach((arr) => arr.forEach(mapFile));
  }
}

function wrapMw(mw) {
  return async (req, res, next) => {
    mw(req, res, (err) => {
      if (err) return next(err);
      try {
        enforceFileSizeLimits(req);
        ensureLocations(req);
        next();
      } catch (e) {
        next(e);
      }
    });
  };
}

function enforceFileSizeLimits(req) {
  if (!req) return;
  const toMb = (bytes) => Math.round(bytes / (1024 * 1024));
  const check = (file) => {
    if (!file || typeof file.size !== "number") return;
    const limit = MAX_FILE_SIZES[file.fieldname];
    if (!limit) return;
    if (file.size > limit) {
      const err = new Error(`${file.fieldname} exceeds ${toMb(limit)}MB limit`);
      err.statusCode = 413;
      throw err;
    }
  };

  if (req.file) check(req.file);
  if (Array.isArray(req.files)) {
    req.files.forEach(check);
  } else if (req.files) {
    Object.values(req.files)
      .filter(Array.isArray)
      .forEach((arr) => arr.forEach(check));
  }
}

const uploadS3 = {
  single: (field) => wrapMw(upload.single(field)),
  array: (field, maxCount) => wrapMw(upload.array(field, maxCount)),
  fields: (defs) => wrapMw(upload.fields(defs)),
  any: () => wrapMw(upload.any()),
};

module.exports = uploadS3;
