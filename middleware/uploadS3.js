// middleware/uploadS3.js
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const uploadsDir = path.join(process.cwd(), "uploads");
try { fs.mkdirSync(uploadsDir, { recursive: true }); } catch (_) {}

const storage = multer.diskStorage({
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

function patchLocation(req) {
  if (req && req.files) {
    const baseUrl = process.env.BASE_URL || "";
    const mapFile = (f) => {
      const rel = path.join("uploads", path.basename(f.path)).replace(/\\/g, "/");
      f.location = baseUrl ? `${baseUrl.replace(/\/$/, "")}/${rel}` : `/${rel}`;
      return f;
    };
    Object.keys(req.files).forEach((k) => {
      const arr = req.files[k];
      if (Array.isArray(arr)) req.files[k] = arr.map(mapFile);
    });
  }
}

function wrapMw(mw) {
  return (req, res, next) => mw(req, res, (err) => {
    if (err) return next(err);
    patchLocation(req);
    next();
  });
}

const uploadS3 = {
  single: (field) => wrapMw(upload.single(field)),
  array: (field, maxCount) => wrapMw(upload.array(field, maxCount)),
  fields: (defs) => wrapMw(upload.fields(defs)),
  any: () => wrapMw(upload.any()),
};

module.exports = uploadS3;
