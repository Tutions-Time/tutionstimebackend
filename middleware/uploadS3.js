// middleware/uploadS3.js
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

// Env-driven S3 configuration
// support multiple env var names for compatibility
const S3_BUCKET = process.env.AWS_S3_BUCKET || process.env.AWS_BUCKET;
const S3_REGION = process.env.AWS_REGION;
const S3_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY;
const S3_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY || process.env.AWS_SECRET_KEY;

const useS3 = Boolean(S3_BUCKET && S3_REGION && S3_ACCESS_KEY_ID && S3_SECRET_ACCESS_KEY);

// Fallback local uploads directory
const uploadsDir = path.join(process.cwd(), "uploads");
try { fs.mkdirSync(uploadsDir, { recursive: true }); } catch (_) {}

// Memory storage for S3; disk for fallback
const storage = useS3 ? multer.memoryStorage() : multer.diskStorage({
  destination: function (_req, file, cb) {
    cb(null, uploadsDir);
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname);
    const base = path.basename(file.originalname, ext).replace(/[^A-Za-z0-9_-]/g, "_");
    const sessionId = req.params?.id || "general";
    const unique = `${file.fieldname}-${Date.now()}-${Math.round(Math.random()*1e9)}`;
    cb(null, `${sessionId}-${base}-${unique}${ext}`);
  },
});

const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

// Initialize S3 client if configured
let s3 = null;
if (useS3) {
  s3 = new S3Client({
    region: S3_REGION,
    credentials: { accessKeyId: S3_ACCESS_KEY_ID, secretAccessKey: S3_SECRET_ACCESS_KEY },
  });
}

function buildKey(req, file) {
  const ext = path.extname(file.originalname);
  const base = path.basename(file.originalname, ext).replace(/[^A-Za-z0-9_-]/g, "_");
  const scope = req.params?.id || "general";
  const unique = `${file.fieldname}-${Date.now()}-${Math.round(Math.random()*1e9)}`;
  return `uploads/${scope}-${base}-${unique}${ext}`;
}

async function uploadFileToS3(req, file) {
  const key = buildKey(req, file);
  const contentType = file.mimetype || "application/octet-stream";
  await s3.send(new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: key,
    Body: file.buffer,
    ContentType: contentType,
    // ACL: "public-read",
  }));
  const location = `https://${S3_BUCKET}.s3.${S3_REGION}.amazonaws.com/${key}`;
  file.location = location;
  file.key = key;
}

async function ensureLocations(req) {
  if (!req) return;

  // S3 path: upload and set location
  if (useS3) {
    if (req.file && !req.file.location) {
      await uploadFileToS3(req, req.file);
    }
    if (req.files) {
      const groups = Object.values(req.files).filter(Array.isArray);
      for (const arr of groups) {
        for (const f of arr) {
          if (!f.location) await uploadFileToS3(req, f);
        }
      }
    }
    return;
  }

  // Fallback: local disk – set location based on BASE_URL
  const baseUrl = process.env.BASE_URL || "";
  const mapFile = (f) => {
    if (!f.location && f.path) {
      const rel = path.join("uploads", path.basename(f.path)).replace(/\\/g, "/");
      f.location = baseUrl ? `${baseUrl.replace(/\/$/, "")}/${rel}` : `/${rel}`;
      f.key = rel; // emulate s3 key for local
    }
  };
  if (req.file) mapFile(req.file);
  if (req.files) {
    Object.keys(req.files).forEach((k) => {
      const arr = req.files[k];
      if (Array.isArray(arr)) arr.forEach(mapFile);
    });
  }
}

function wrapMw(mw) {
  return async (req, res, next) => {
    mw(req, res, async (err) => {
      if (err) return next(err);
      try {
        await ensureLocations(req);
        next();
      } catch (e) {
        next(e);
      }
    });
  };
}

const uploadS3 = {
  single: (field) => wrapMw(upload.single(field)),
  array: (field, maxCount) => wrapMw(upload.array(field, maxCount)),
  fields: (defs) => wrapMw(upload.fields(defs)),
  any: () => wrapMw(upload.any()),
};

module.exports = uploadS3;
